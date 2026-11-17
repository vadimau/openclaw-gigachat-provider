import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createBridge } from "../lib/server.js";
import { readSettings } from "../lib/settings.js";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("bridge proxies text and tool calls through GigaChat formats", async () => {
  let lastAuth = "";
  let lastChatBody;
  const oauth = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ access_token: "token-1", expires_at: Date.now() + 3600_000 }));
  });
  const chat = http.createServer(async (req, res) => {
    lastAuth = req.headers.authorization ?? "";
    lastChatBody = await readJson(req);
    if (lastChatBody.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        'data: {"choices":[{"delta":{"content":"Привет","role":"assistant"},"index":0}],"created":1,"model":"GigaChat-2"}\n\n',
      );
      res.write(
        'data: {"choices":[{"delta":{"function_call":{"name":"weather","arguments":{"city":"Москва"}},"functions_state_id":"s1"},"index":0,"finish_reason":"function_call"}],"created":1,"model":"GigaChat-2","usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      );
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        model: "GigaChat-2",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });

  const oauthPort = await listen(oauth);
  const chatPort = await listen(chat);
  const settings = readSettings({
    port: 19191,
    oauthUrl: `http://127.0.0.1:${oauthPort}/oauth`,
    apiBaseUrl: `http://127.0.0.1:${chatPort}/v1`,
  });
  const bridge = createBridge(settings);
  await bridge.start();

  try {
    const response = await fetch("http://127.0.0.1:19191/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer id:secret",
      },
      body: JSON.stringify({
        model: "GigaChat-2",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "weather",
              description: "Weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /"content":"Привет"/);
    assert.match(text, /"name":"weather"/);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(lastAuth, "Bearer token-1");
    assert.equal(lastChatBody.messages[0].role, "user");
    assert.equal(lastChatBody.functions[0].name, "weather");
    assert.equal(lastChatBody.function_call, "auto");

    const plain = await fetch("http://127.0.0.1:19191/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer id:secret",
      },
      body: JSON.stringify({
        model: "GigaChat-2",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const payload = await plain.json();
    assert.equal(payload.choices[0].message.content, "ok");
    assert.equal(payload.usage.total_tokens, 2);
  } finally {
    await bridge.stop();
    await close(oauth);
    await close(chat);
  }
});
