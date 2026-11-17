import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const FUNCTION_FINISH = new Set(["function_call", "function_call_error"]);

export function createCallId() {
  return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function createResponseId() {
  return `chatcmpl-gigachat-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function sanitizeToolName(name, used = new Set()) {
  let base = String(name ?? "tool")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/^[^A-Za-z_]+/, (prefix) => `tool_${prefix}`);
  if (!base) {
    base = "tool";
  }
  base = base.slice(0, 60);
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

export function contentToText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function mergePropertySchemas(schemas) {
  const values = [];
  for (const schema of schemas) {
    if (!schema || typeof schema !== "object") {
      continue;
    }
    if (schema.const !== undefined) {
      values.push(schema.const);
    }
    if (Array.isArray(schema.enum)) {
      values.push(...schema.enum);
    }
  }
  if (values.length > 0) {
    const unique = [...new Set(values)];
    return {
      type: "string",
      ...(unique.length > 1 ? { enum: unique } : {}),
    };
  }
  return schemas.find((schema) => schema && typeof schema === "object") ?? {};
}

function mergeUnionVariants(variants) {
  const objects = variants.filter(
    (variant) =>
      variant &&
      typeof variant === "object" &&
      (variant.type === "object" || (variant.properties && typeof variant.properties === "object")),
  );
  if (objects.length === variants.length && objects.length > 0) {
    const propertyLists = new Map();
    for (const variant of objects) {
      for (const [name, schema] of Object.entries(variant.properties ?? {})) {
        const list = propertyLists.get(name) ?? [];
        list.push(schema);
        propertyLists.set(name, list);
      }
    }
    const properties = {};
    for (const [name, schemas] of propertyLists) {
      properties[name] = mergePropertySchemas(schemas);
    }
    const requiredSets = objects.map((variant) => new Set(variant.required ?? []));
    const required = (objects[0].required ?? []).filter((name) =>
      requiredSets.every((set) => set.has(name)),
    );
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  const literals = variants.filter(
    (variant) =>
      variant &&
      typeof variant === "object" &&
      (variant.const !== undefined || Array.isArray(variant.enum)),
  );
  if (literals.length === variants.length && literals.length > 0) {
    const values = [];
    for (const variant of literals) {
      if (variant.const !== undefined) {
        values.push(variant.const);
      }
      if (Array.isArray(variant.enum)) {
        values.push(...variant.enum);
      }
    }
    const unique = [...new Set(values)];
    const type = literals[0]?.type;
    return {
      ...(typeof type === "string" ? { type } : { type: "string" }),
      ...(unique.length > 1 ? { enum: unique } : {}),
    };
  }

  return variants.find((variant) => variant?.type !== "null") ?? variants[0] ?? {};
}

function toFunctionResultContent(content) {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  try {
    JSON.parse(text);
    return text;
  } catch {
    return JSON.stringify({ result: text });
  }
}

export function normalizeJsonSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 20) {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeJsonSchema(item, depth + 1));
  }
  const out = { ...schema };
  const validTypes = new Set(["string", "number", "integer", "boolean", "array", "object"]);
  if (Array.isArray(out.type)) {
    out.type = out.type.find((type) => validTypes.has(type)) ?? "string";
  }
  if (out.type === "null") {
    out.type = "string";
  }
  if (typeof out.type === "string" && !validTypes.has(out.type)) {
    delete out.type;
  }
  if (out.const !== undefined && out.enum === undefined) {
    out.enum = [out.const];
    delete out.const;
  }
  if (out.properties && typeof out.properties === "object" && !Array.isArray(out.properties)) {
    out.type ??= "object";
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([name, value]) => [
        name,
        normalizeJsonSchema(value, depth + 1),
      ]),
    );
  } else if (out.type === "object") {
    out.properties = {};
  }
  if (out.type === "array" && !out.items) {
    out.items = { type: "string" };
  } else if (out.items) {
    out.items = normalizeJsonSchema(out.items, depth + 1);
  }
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(out[key]) && out[key].length > 0) {
      const variants = out[key].map((item) => normalizeJsonSchema(item, depth + 1));
      delete out[key];
      Object.assign(out, mergeUnionVariants(variants));
    }
  }
  if (Array.isArray(out.allOf) && out.allOf.length > 0) {
    const variants = out.allOf.map((item) => normalizeJsonSchema(item, depth + 1));
    delete out.allOf;
    Object.assign(out, mergeUnionVariants(variants));
  }
  if (Array.isArray(out.required) && out.properties) {
    out.required = out.required.filter(
      (name) => typeof name === "string" && Object.hasOwn(out.properties, name),
    );
  }
  return out;
}

function parseArguments(value) {  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeFinishReason(reason) {
  switch (reason) {
    case "function_call":
    case "function_call_error":
      return "tool_calls";
    case "length":
      return "length";
    case "blacklist":
    case "request_blacklist":
    case "request_whitelist":
    case "request_filter":
    case "response_blacklist":
      return "content_filter";
    default:
      return "stop";
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion,
  };
}

export class GigaChatStateStore {
  constructor() {
    this.byCallId = new Map();
    this.byToolName = new Map();
  }

  remember(callId, { toolName, stateId } = {}) {
    if (!callId) {
      return;
    }
    const current = this.byCallId.get(callId) ?? {};
    this.byCallId.set(callId, {
      stateId: stateId ?? current.stateId,
      toolName: toolName ?? current.toolName,
    });
    if (toolName) {
      this.byToolName.set(toolName, callId);
    }
  }

  stateIdFor(callId) {
    return this.byCallId.get(callId)?.stateId;
  }

  toolNameFor(callId) {
    return this.byCallId.get(callId)?.toolName;
  }

  clear() {
    this.byCallId.clear();
    this.byToolName.clear();
  }
}

/**
 * Converts an OpenAI Chat Completions request into a GigaChat v1 request.
 * Returns the payload plus the maps needed to translate the response back.
 */
export function toGigaChatRequest(body, stateStore) {
  const usedNames = new Set();
  const toolNames = new Map();
  const toolNamesReverse = new Map();
  const functions = [];

  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const fn = tool?.type === "function" ? tool.function : undefined;
    if (!fn || typeof fn.name !== "string" || !fn.name.trim()) {
      continue;
    }
    const sanitized = sanitizeToolName(fn.name, usedNames);
    toolNames.set(fn.name, sanitized);
    toolNamesReverse.set(sanitized, fn.name);
    functions.push({
      name: sanitized,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      ...(fn.parameters && typeof fn.parameters === "object"
        ? { parameters: normalizeJsonSchema(fn.parameters) }
        : {}),
    });
  }

  const systemParts = [];
  const messages = [];
  const toolCallNames = new Map();

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = message.role;
    if (role === "system" || role === "developer") {
      const text = contentToText(message.content);
      if (text.trim()) {
        systemParts.push(text);
      }
      continue;
    }
    if (role === "tool") {
      const callId = message.tool_call_id;
      const name =
        toolCallNames.get(callId) ||
        stateStore?.toolNameFor(callId) ||
        (typeof message.name === "string" ? message.name : undefined) ||
        "tool";
      messages.push({
        role: "function",
        name: toolNames.get(name) ?? sanitizeToolName(name, usedNames),
        content: toFunctionResultContent(message.content),
      });
      continue;
    }
    if (role === "assistant") {
      const text = contentToText(message.content);
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (calls.length === 0) {
        messages.push({ role: "assistant", content: text });
        continue;
      }
      calls.forEach((call, index) => {
        const callId = call?.id;
        const originalName = call?.function?.name;
        const name =
          toolNames.get(originalName) ?? sanitizeToolName(originalName ?? "tool", usedNames);
        if (callId) {
          toolCallNames.set(callId, originalName ?? name);
        }
        const stateId = stateStore?.stateIdFor(callId);
        messages.push({
          role: "assistant",
          content: index === 0 ? text : "",
          function_call: {
            name,
            arguments: parseArguments(call?.function?.arguments),
          },
          ...(stateId ? { functions_state_id: stateId } : {}),
        });
      });
      continue;
    }
    messages.push({ role: "user", content: contentToText(message.content) });
  }

  const request = {
    model: body.model,
    messages: systemParts.length
      ? [{ role: "system", content: systemParts.join("\n\n") }, ...messages]
      : messages,
    stream: body.stream === true,
    update_interval: 0,
  };

  if (functions.length > 0) {
    request.functions = functions;
    request.function_call = mapToolChoice(body.tool_choice, toolNames);
  }

  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) {
    request.max_tokens = Number(maxTokens);
  }
  if (body.temperature !== undefined && body.temperature !== null) {
    const temperature = Number(body.temperature);
    if (Number.isFinite(temperature)) {
      request.temperature = temperature <= 0 ? 0.001 : temperature;
    }
  }
  if (body.top_p !== undefined && body.top_p !== null && Number.isFinite(Number(body.top_p))) {
    request.top_p = Number(body.top_p);
  }
  if (body.response_format && typeof body.response_format === "object") {
    request.response_format = body.response_format;
  }

  return { request, toolNames, toolNamesReverse };
}

function mapToolChoice(choice, toolNames) {
  if (typeof choice === "string") {
    if (choice === "none") {
      return "none";
    }
    return "auto";
  }
  if (choice && typeof choice === "object" && choice.type === "function") {
    const name = choice.function?.name;
    const mapped = toolNames.get(name);
    if (mapped) {
      return { name: mapped };
    }
  }
  return "auto";
}

export function fromGigaChatResponse(payload, { toolNamesReverse, stateStore } = {}) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
  const source = choice?.message ?? {};
  const text = typeof source.content === "string" ? source.content : "";
  const finishReason =
    normalizeFinishReason(choice?.finish_reason) ?? (source.function_call ? "tool_calls" : "stop");

  let toolCalls;
  if (source.function_call && typeof source.function_call === "object") {
    const callId = createCallId();
    const apiName = source.function_call.name;
    const name = toolNamesReverse?.get(apiName) ?? apiName ?? "tool";
    stateStore?.remember(callId, { toolName: name, stateId: source.functions_state_id });
    toolCalls = [
      {
        id: callId,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(parseArguments(source.function_call.arguments)),
        },
      },
    ];
  }

  return {
    id: createResponseId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: payload?.model ?? "",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? "tool_calls" : finishReason,
      },
    ],
    usage: normalizeUsage(payload?.usage) ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

/**
 * Incremental GigaChat SSE -> OpenAI SSE converter.
 * push() accepts raw bytes and returns zero or more OpenAI `data:` frames.
 */
export function createSseConverter({ toolNamesReverse, stateStore } = {}) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let responseId = createResponseId();
  let created = Math.floor(Date.now() / 1000);
  let model = "";
  let finished = false;
  let doneSent = false;
  let pendingUsage;
  let emittedChunk = false;
  let toolCallId;

  const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

  const chunk = (delta, finishReason, usage) => ({
    id: responseId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    ...(usage ? { usage } : {}),
  });

  const handlePayload = (payload) => {
    if (!payload || typeof payload !== "object") {
      return "";
    }
    if (typeof payload.created === "number") {
      created = payload.created;
    }
    if (typeof payload.model === "string" && payload.model) {
      model = payload.model;
    }
    const usage = normalizeUsage(payload.usage);
    if (usage) {
      pendingUsage = usage;
    }

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    if (!choice) {
      return "";
    }
    const delta = choice.delta ?? {};
    let out = "";

    const text = typeof delta.content === "string" ? delta.content : "";
    const role = typeof delta.role === "string" ? delta.role : undefined;
    if (text || role) {
      out += frame(chunk({ ...(role ? { role } : {}), ...(text ? { content: text } : {}) }));
      emittedChunk = true;
    }

    if (delta.function_call && typeof delta.function_call === "object") {
      toolCallId = createCallId();
      const apiName = delta.function_call.name;
      const name = toolNamesReverse?.get(apiName) ?? apiName ?? "tool";
      stateStore?.remember(toolCallId, {
        toolName: name,
        stateId: delta.functions_state_id ?? choice.functions_state_id ?? payload.functions_state_id,
      });
      out += frame(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: toolCallId,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(parseArguments(delta.function_call.arguments)),
              },
            },
          ],
        }),
      );
      emittedChunk = true;
    }

    if (choice.finish_reason) {
      out += frame(
        chunk({}, normalizeFinishReason(choice.finish_reason), pendingUsage),
      );
      pendingUsage = undefined;
      finished = true;
      emittedChunk = true;
    }

    return out;
  };

  const processBuffer = (flush) => {
    let out = "";
    buffer = buffer.replace(/\r\n/g, "\n");
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) {
          continue;
        }
        const data = line.slice(5).trim();
        if (!data) {
          continue;
        }
        if (data === "[DONE]") {
          out += "data: [DONE]\n\n";
          finished = true;
          doneSent = true;
          continue;
        }
        try {
          out += handlePayload(JSON.parse(data));
        } catch {
          // Ignore malformed upstream frames; the transport will surface a terminal error.
        }
      }
      index = buffer.indexOf("\n\n");
    }
    if (flush && buffer.trim()) {
      const data = buffer.trim().replace(/^data:\s*/, "");
      if (data === "[DONE]") {
        out += "data: [DONE]\n\n";
        finished = true;
        doneSent = true;
      } else if (data) {
        try {
          out += handlePayload(JSON.parse(data));
        } catch {
          // ignore
        }
      }
      buffer = "";
    }
    return out;
  };

  return {
    push(bytes) {
      buffer += decoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
      return processBuffer(false);
    },
    end() {
      buffer += decoder.end();
      let out = processBuffer(true);
      if (!finished) {
        out += frame(chunk({}, "stop", pendingUsage));
        emittedChunk = true;
      }
      if (!emittedChunk) {
        out += frame(chunk({ role: "assistant", content: "" }));
      }
      if (!doneSent) {
        out += "data: [DONE]\n\n";
      }
      return out;
    },
  };
}
