export const DEFAULT_SETTINGS = {
  port: 18080,
  localToken: "gigachat-local",
  scope: "GIGACHAT_API_PERS",
  apiBaseUrl: "https://api.giga.chat/v1",
  oauthUrl: "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
  maxContextTokens: 128000,
  insecureTls: false,
};

function pickString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function pickPort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : fallback;
}

export function readSettings(pluginConfig = {}, env = process.env) {
  const config = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  const clientPair =
    typeof config.clientId === "string" &&
    config.clientId.trim() &&
    typeof config.clientSecret === "string" &&
    config.clientSecret.trim()
      ? Buffer.from(`${config.clientId.trim()}:${config.clientSecret.trim()}`).toString("base64")
      : "";
  return {
    port: pickPort(config.port ?? env.GIGACHAT_BRIDGE_PORT, DEFAULT_SETTINGS.port),
    localToken: pickString(config.localToken ?? env.GIGACHAT_LOCAL_TOKEN, DEFAULT_SETTINGS.localToken),
    authKey: pickString(clientPair || config.authKey || env.GIGACHAT_AUTH_KEY, ""),
    scope: pickString(config.scope ?? env.GIGACHAT_SCOPE, DEFAULT_SETTINGS.scope),
    apiBaseUrl: pickString(
      config.apiBaseUrl ?? env.GIGACHAT_API_BASE_URL,
      DEFAULT_SETTINGS.apiBaseUrl,
    ).replace(/\/+$/, ""),
    oauthUrl: pickString(config.oauthUrl ?? env.GIGACHAT_OAUTH_URL, DEFAULT_SETTINGS.oauthUrl),
    caFile: pickString(config.caFile ?? env.GIGACHAT_CA_FILE, ""),
    maxContextTokens: Number(config.maxContextTokens) || DEFAULT_SETTINGS.maxContextTokens,
    insecureTls: config.insecureTls === true || env.GIGACHAT_INSECURE_TLS === "1",
  };
}
