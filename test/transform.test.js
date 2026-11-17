import assert from "node:assert/strict";
import test from "node:test";
import {
  createSseConverter,
  fromGigaChatResponse,
  GigaChatStateStore,
  normalizeJsonSchema,
  sanitizeToolName,
  toGigaChatRequest,
} from "../lib/transform.js";

test("sanitizeToolName keeps safe names and avoids collisions", () => {
  const used = new Set();
  assert.equal(sanitizeToolName("read_file", used), "read_file");
  assert.equal(sanitizeToolName("server.tool", used), "server_tool");
  assert.equal(sanitizeToolName("server_tool", used), "server_tool_2");
});

test("normalizeJsonSchema fills missing object properties", () => {
  const normalized = normalizeJsonSchema({
    type: "object",
    properties: { args: { type: "object" }, list: { type: "array" } },
    required: ["args", "missing"],
  });
  assert.deepEqual(normalized.properties.args, { type: "object", properties: {} });
  assert.deepEqual(normalized.properties.list, { type: "array", items: { type: "string" } });
  assert.deepEqual(normalized.required, ["args"]);
  const union = normalizeJsonSchema({ type: ["string", "null"], const: "a" });
  assert.equal(union.type, "string");
  assert.deepEqual(union.enum, ["a"]);

  const action = normalizeJsonSchema({
    anyOf: [
      {
        type: "object",
        properties: { type: { const: "command" }, command: { type: "string" } },
        required: ["type", "command"],
      },
      {
        type: "object",
        properties: { type: { const: "url" }, url: { type: "string" } },
        required: ["type", "url"],
      },
    ],
  });
  assert.equal(action.type, "object");
  assert.deepEqual(action.properties.type.enum, ["command", "url"]);
  assert.deepEqual(action.required, ["type"]);

  const literalUnion = normalizeJsonSchema({
    anyOf: [
      { type: "string", const: "a" },
      { type: "string", const: "b" },
    ],
  });
  assert.deepEqual(literalUnion, { type: "string", enum: ["a", "b"] });
});

test("toGigaChatRequest converts tools, tool calls and tool results", () => {
  const state = new GigaChatStateStore();
  state.remember("call_1", { toolName: "read_file", stateId: "state-1" });
  const { request, toolNamesReverse } = toGigaChatRequest(
    {
      model: "GigaChat-2",
      temperature: 0,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "file data" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
      stream: true,
    },
    state,
  );

  assert.equal(request.model, "GigaChat-2");
  assert.equal(request.stream, true);
  assert.equal(request.temperature, 0.001);
  assert.deepEqual(request.messages[0], { role: "system", content: "sys" });
  assert.equal(request.messages[2].role, "assistant");
  assert.deepEqual(request.messages[2].function_call.arguments, { path: "a.txt" });
  assert.equal(request.messages[2].functions_state_id, "state-1");
  assert.deepEqual(request.messages[3], {
    role: "function",
    name: "read_file",
    content: JSON.stringify({ result: "file data" }),
  });
  assert.equal(request.functions[0].name, "read_file");
  assert.equal(request.function_call, "auto");
  assert.equal(toolNamesReverse.get("read_file"), "read_file");
});

test("fromGigaChatResponse converts function_call into tool_calls", () => {
  const state = new GigaChatStateStore();
  const converted = fromGigaChatResponse(
    {
      model: "GigaChat-2-Pro",
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            function_call: { name: "weather", arguments: { city: "Москва" } },
            functions_state_id: "state-42",
          },
          finish_reason: "function_call",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    },
    { toolNamesReverse: new Map([["weather", "weather"]]), stateStore: state },
  );
  assert.equal(converted.choices[0].finish_reason, "tool_calls");
  const call = converted.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "weather");
  assert.deepEqual(JSON.parse(call.function.arguments), { city: "Москва" });
  assert.equal(state.stateIdFor(call.id), "state-42");
  assert.deepEqual(converted.usage, {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
  });
});

test("SSE converter emits text and a tool call", () => {
  const state = new GigaChatStateStore();
  const converter = createSseConverter({
    toolNamesReverse: new Map([["weather", "weather"]]),
    stateStore: state,
  });
  const input =
    'data: {"choices":[{"delta":{"content":"Hello","role":"assistant"},"index":0}],"created":1,"model":"GigaChat-2"}\n\n' +
    'data: {"choices":[{"delta":{"content":"","function_call":{"name":"weather","arguments":{"city":"Москва"}},"functions_state_id":"s1"},"index":0,"finish_reason":"function_call"}],"created":1,"model":"GigaChat-2","usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
    "data: [DONE]\n\n";
  const output = converter.push(Buffer.from(input)) + converter.end();
  const frames = output
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => frame.replace(/^data:\s*/, ""))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));

  assert.equal(frames[0].choices[0].delta.content, "Hello");
  const toolFrame = frames.find((frame) => frame.choices[0].delta.tool_calls);
  assert.equal(toolFrame.choices[0].delta.tool_calls[0].function.name, "weather");
  assert.deepEqual(JSON.parse(toolFrame.choices[0].delta.tool_calls[0].function.arguments), {
    city: "Москва",
  });
  const terminal = frames.find((frame) => frame.choices[0].finish_reason === "tool_calls");
  assert.equal(terminal.usage.total_tokens, 5);
  assert.match(output, /data: \[DONE\]\n\n$/);
});




