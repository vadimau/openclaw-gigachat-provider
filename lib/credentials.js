import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.resolve(here, "..", "certs");

function readPem(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function loadCaBundle(settings = {}) {
  const parts = [
    readPem(path.join(CERT_DIR, "russian_trusted_root_ca.pem")),
    readPem(path.join(CERT_DIR, "russian_trusted_sub_ca.pem")),
  ].filter(Boolean);

  if (settings.caFile) {
    const extra = readPem(path.resolve(settings.caFile));
    if (extra) {
      parts.push(extra);
    }
  }
  if (settings.ca) {
    parts.push(String(settings.ca));
  }
  return parts;
}

export function normalizeAuthKey(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "";
  }
  if (value.includes(":")) {
    return Buffer.from(value, "utf8").toString("base64");
  }
  return value;
}

export function readBearer(authorization) {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization ?? "").trim());
  return match ? match[1].trim() : "";
}

function selectTransport(url) {
  return url.protocol === "http:" ? http : https;
}

export function openRequest(urlString, options = {}) {
  const url = new URL(urlString);
  const transport = selectTransport(url);
  const ca = options.ca?.length ? options.ca : undefined;
  const insecure =
    options.insecureTls === true || process.env.GIGACHAT_INSECURE_TLS === "1";

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        ca,
        rejectUnauthorized: !insecure,
        timeout: options.timeoutMs ?? 120_000,
      },
      resolve,
    );
    const onAbort = () => req.destroy(new Error("GigaChat request aborted"));
    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy(new Error("GigaChat request aborted"));
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
        req.on("close", () => options.signal.removeEventListener("abort", onAbort));
      }
    }
    req.on("timeout", () => req.destroy(new Error("GigaChat request timed out")));
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

export async function readBody(response, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    total += chunk.length;
    if (total > limitBytes) {
      response.destroy();
      throw new Error("GigaChat response is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson(response, label = "GigaChat response") {
  const text = await readBody(response);
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON: ${text.slice(0, 300)}`);
  }
}

const tokenCache = new Map();
const tokenInFlight = new Map();

function tokenCacheKey(authKey, settings) {
  return `${settings.oauthUrl}|${settings.scope}|${authKey}`;
}

export async function getAccessToken(authKey, settings) {
  const key = tokenCacheKey(authKey, settings);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - 60_000 > Date.now()) {
    return cached.token;
  }
  const pending = tokenInFlight.get(key);
  if (pending) {
    return await pending;
  }

  const task = (async () => {
    const body = new URLSearchParams({ scope: settings.scope }).toString();
    const response = await openRequest(settings.oauthUrl, {
      method: "POST",
      ca: loadCaBundle(settings),
      insecureTls: settings.insecureTls,
      timeoutMs: 30_000,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        RqUID: crypto.randomUUID(),
        Authorization: `Basic ${authKey}`,
      },
      body,
    });

    const payload = await readJson(response, "GigaChat OAuth");
    if (response.statusCode !== 200 || !payload.access_token) {
      const message =
        payload?.message || payload?.error_description || payload?.error || "OAuth failed";
      const error = new Error(`GigaChat OAuth ${response.statusCode}: ${message}`);
      error.statusCode = response.statusCode;
      throw error;
    }

    const expiresAt =
      Number(payload.expires_at) ||
      Date.now() + Math.max(60, Number(payload.expires_in) || 1800) * 1000;
    tokenCache.set(key, { token: payload.access_token, expiresAt });
    return payload.access_token;
  })().finally(() => tokenInFlight.delete(key));

  tokenInFlight.set(key, task);
  return await task;
}

export function clearTokenCache() {
  tokenCache.clear();
  tokenInFlight.clear();
}
