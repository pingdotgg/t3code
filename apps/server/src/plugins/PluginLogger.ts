import type { PluginId } from "@t3tools/contracts/plugin";
import type { PluginLogger } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";

export const makePluginLogger = (pluginId: PluginId): PluginLogger => ({
  debug: (message, attributes) => Effect.logDebug(message, { ...attributes, pluginId }),
  info: (message, attributes) => Effect.logInfo(message, { ...attributes, pluginId }),
  warn: (message, attributes) => Effect.logWarning(message, { ...attributes, pluginId }),
  error: (message, attributes) => Effect.logError(message, { ...attributes, pluginId }),
});
