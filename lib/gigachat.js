import {
  getAccessToken,
  loadCaBundle,
  openRequest,
  readJson,
} from "./credentials.js";

export class GigaChatError extends Error {
  constructor(message, statusCode, detail) {
    super(message);
    this.name = "GigaChatError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? "").replace(/\/+$/, "");
}

export async function requestGigaChatChat({ authKey, settings, payload, signal, tokenOverride }) {
  const token = tokenOverride ?? (await getAccessToken(authKey, settings));
  const ca = loadCaBundle(settings);
  const url = `${normalizeBaseUrl(settings.apiBaseUrl)}/chat/completions`;
  const response = await openRequest(url, {
    method: "POST",
    ca,
    insecureTls: settings.insecureTls,
    signal,
    timeoutMs: 300_000,
    headers: {
      Accept: payload.stream ? "text/event-stream" : "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (response.statusCode !== 200) {
    let detail;
    try {
      detail = await readJson(response, "GigaChat chat");
    } catch {
      detail = undefined;
    }
    const message =
      detail?.message ||
      detail?.error?.message ||
      `GigaChat chat request failed with HTTP ${response.statusCode}`;
    throw new GigaChatError(message, response.statusCode, detail);
  }

  return response;
}

export async function requestGigaChatModels({ authKey, settings, signal }) {
  const token = await getAccessToken(authKey, settings);
  const ca = loadCaBundle(settings);
  const response = await openRequest(`${normalizeBaseUrl(settings.apiBaseUrl)}/models`, {
    method: "GET",
    ca,
    insecureTls: settings.insecureTls,
    signal,
    timeoutMs: 30_000,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (response.statusCode !== 200) {
    await readJson(response, "GigaChat models").catch(() => undefined);
    throw new GigaChatError(
      `GigaChat models request failed with HTTP ${response.statusCode}`,
      response.statusCode,
    );
  }
  return await readJson(response, "GigaChat models");
}
