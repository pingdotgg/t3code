import type { OpenRouterSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeClaudeAdapter, type ClaudeAdapterLiveOptions } from "./ClaudeAdapter.ts";
import {
  buildOpenRouterProcessEnv,
  OPENROUTER_DRIVER_KIND,
  toClaudeSettings,
} from "../openrouter/OpenRouterRuntime.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

export type OpenRouterAdapterLiveOptions = {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
};

export const makeOpenRouterAdapter = Effect.fn("makeOpenRouterAdapter")(function* (
  settings: OpenRouterSettings,
  options?: OpenRouterAdapterLiveOptions,
) {
  const processEnv = buildOpenRouterProcessEnv(settings, options?.environment);
  const claudeSettings = toClaudeSettings(settings);
  const claudeOptions: ClaudeAdapterLiveOptions = {
    ...(options?.instanceId ? { instanceId: options.instanceId } : {}),
    environment: processEnv,
    provider: OPENROUTER_DRIVER_KIND,
    ...(options?.nativeEventLogPath ? { nativeEventLogPath: options.nativeEventLogPath } : {}),
    ...(options?.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
  };
  return yield* makeClaudeAdapter(claudeSettings, claudeOptions);
});
