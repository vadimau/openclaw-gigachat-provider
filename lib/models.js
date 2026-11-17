export const PROVIDER_ID = "gigachat";
export const DEFAULT_PORT = 18080;
export const DEFAULT_SCOPE = "GIGACHAT_API_PERS";
export const DEFAULT_API_BASE_URL = "https://api.giga.chat/v1";
export const DEFAULT_OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";

const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const GIGACHAT_MODELS = [
  {
    id: "GigaChat-3-Ultra",
    name: "GigaChat 3 Ultra",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: FREE_COST,
    compat: { supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
  },
  {
    id: "GigaChat-2-Max",
    name: "GigaChat 2 Max",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: FREE_COST,
    compat: { supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
  },
  {
    id: "GigaChat-2-Pro",
    name: "GigaChat 2 Pro",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: FREE_COST,
    compat: { supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
  },
  {
    id: "GigaChat-2",
    name: "GigaChat 2 Lite",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: FREE_COST,
    compat: { supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
  },
];

export function buildProviderConfig(port = DEFAULT_PORT, contextWindow) {
  return {
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: GIGACHAT_MODELS.map((model) =>
      Number(contextWindow) > 0 ? { ...model, contextWindow: Number(contextWindow) } : model,
    ),
  };
}
