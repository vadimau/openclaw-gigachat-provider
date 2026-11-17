import crypto from "node:crypto";
import http from "node:http";
import { readBearer } from "./credentials.js";
import { GigaChatError, requestGigaChatChat } from "./gigachat.js";
import { GIGACHAT_MODELS } from "./models.js";
import {
  createSseConverter,
  fromGigaChatResponse,
  GigaChatStateStore,
  toGigaChatRequest,
} from "./transform.js";

const MAX_BODY_BYTES = 20 * 1024 * 1024;

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function errorResponse(res, statusCode, message, type = "gigachat_error") {
  jsonResponse(res, statusCode, {
    error: {
      message: String(message ?? "GigaChat request failed"),
      type,
      code: statusCode,
    },
  });
}

async function readJsonBody(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body is too large");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

function resolveCredential(req, settings) {
  const bearer = readBearer(req.headers.authorization);
  if (!bearer) {
    return "";
  }
  if (settings.localToken && bearer === settings.localToken && settings.authKey) {
    return settings.authKey;
  }
  return bearer;
}

function credentialKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function createBridge(settings, logger) {
  const stateStore = new GigaChatStateStore();
  const queues = new Map();
  let server;
  let closed = false;

  const log = (level, message) => {
    const fn = logger?.[level];
    if (typeof fn === "function") {
      fn.call(logger, message);
    }
  };

  const withQueue = (key, task) => {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, settled);
    settled.finally(() => {
      if (queues.get(key) === settled) {
        queues.delete(key);
      }
    });
    return run;
  };

  const handleModels = (res) => {
    jsonResponse(res, 200, {
      object: "list",
      data: GIGACHAT_MODELS.map((model) => ({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: "gigachat",
      })),
    });
  };

  const handleChat = async (req, res) => {
    const credential = resolveCredential(req, settings);
    if (!credential) {
      errorResponse(res, 401, "Missing GigaChat authorization key", "authentication_error");
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      errorResponse(res, 400, error instanceof Error ? error.message : "Invalid JSON");
      return;
    }

    const { request, toolNamesReverse } = toGigaChatRequest(body, stateStore);
    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    try {
      await withQueue(credentialKey(credential), async () => {
        const upstream = await requestGigaChatChat({
          authKey: credential,
          settings,
          payload: request,
          signal: abortController.signal,
        });

        if (request.stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          res.flushHeaders?.();

          const converter = createSseConverter({ toolNamesReverse, stateStore });
          try {
            for await (const chunk of upstream) {
              const out = converter.push(chunk);
              if (out) {
                res.write(out);
              }
            }
            res.write(converter.end());
          } catch (error) {
            if (!abortController.signal.aborted) {
              log("warn", `[gigachat] stream failed: ${error.message}`);
            }
          } finally {
            upstream.destroy();
            res.end();
          }
          return;
        }

        const text = await new Promise((resolve, reject) => {
          const chunks = [];
          upstream.on("data", (chunk) => chunks.push(chunk));
          upstream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          upstream.on("error", reject);
        });
        let payload;
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          throw new Error("GigaChat returned invalid JSON");
        }
        jsonResponse(
          res,
          200,
          fromGigaChatResponse(payload, { toolNamesReverse, stateStore }),
        );
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }
      const status = Number(error?.statusCode) || 502;
      const message = error instanceof Error ? error.message : String(error);
      log("warn", `[gigachat] ${status}: ${message}`);
      if (res.headersSent) {
        res.write(
          `data: ${JSON.stringify({ error: { message, type: "gigachat_error", code: status } })}\n\n`,
        );
        res.end();
        return;
      }
      errorResponse(
        res,
        status,
        status === 402
          ? "GigaChat free quota is exhausted or payment is required (HTTP 402)."
          : message,
      );
    }
  };

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      jsonResponse(res, 200, { ok: true, provider: "gigachat" });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      handleModels(res);
      return;
    }
    if (
      req.method === "POST" &&
      (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
    ) {
      void handleChat(req, res);
      return;
    }
    errorResponse(res, 404, "Not found", "invalid_request_error");
  });

  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 75_000;

  return {
    async start() {
      if (server.listening || closed) {
        return;
      }
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(settings.port, "127.0.0.1");
      });
      log("info", `[gigachat] OpenAI-compatible bridge on http://127.0.0.1:${settings.port}/v1`);
    },
    async stop() {
      closed = true;
      if (!server.listening) {
        return;
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
