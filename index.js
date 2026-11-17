import http from "node:http";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderConfig, PROVIDER_ID } from "./lib/models.js";
import { createBridge } from "./lib/server.js";
import { readSettings } from "./lib/settings.js";

function pluginConfig(api, ctx) {
  return (
    ctx?.config?.plugins?.entries?.[PROVIDER_ID]?.config ??
    api?.pluginConfig ??
    {}
  );
}

function probeBridge(settings) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: settings.port, path: "/health", timeout: 1500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "GigaChat Provider",
  description:
    "GigaChat models for OpenClaw with OAuth, Russian Trusted CA, and an embedded OpenAI-compatible bridge",
  register(api) {
    let bridge;
    let bridgePort;

    const ensureBridge = async (config, logger) => {
      const settings = readSettings(config);
      if (bridge && bridgePort === settings.port) {
        return;
      }
      if (bridge) {
        await bridge.stop().catch(() => undefined);
      }
      bridge = createBridge(settings, logger);
      bridgePort = settings.port;
      try {
        await bridge.start();
      } catch (error) {
        if (error?.code === "EADDRINUSE") {
          const healthy = await probeBridge(settings);
          logger?.warn?.(
            healthy
              ? `[gigachat] port ${settings.port} is already served by a GigaChat bridge; reusing it`
              : `[gigachat] port ${settings.port} is busy and does not look like the GigaChat bridge`,
          );
          return;
        }
        logger?.error?.(`[gigachat] bridge failed to start: ${error?.message ?? error}`);
      }
    };

    api.registerProvider({
      id: PROVIDER_ID,
      label: "GigaChat",
      docsPath: "/providers/gigachat",
      envVars: ["GIGACHAT_AUTH_KEY"],
      catalog: {
        order: "late",
        run: async (ctx) => {
          const settings = readSettings(pluginConfig(api, ctx));
          return {
            provider: buildProviderConfig(settings.port, settings.maxContextTokens),
          };
        },
      },
      staticCatalog: {
        order: "late",
        run: async () => {
          const settings = readSettings(api.pluginConfig);
          return {
            provider: buildProviderConfig(settings.port, settings.maxContextTokens),
          };
        },
      },
    });

    api.registerService({
      id: "gigachat-bridge",
      reload: { configPrefixes: ["plugins.entries.gigachat.config"] },
      start: async (ctx) => {
        await ensureBridge(pluginConfig(api, ctx), ctx.logger);
      },
      stop: async () => {
        if (bridge) {
          await bridge.stop().catch(() => undefined);
          bridge = undefined;
          bridgePort = undefined;
        }
      },
    });
  },
});
