import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { type OllamaSettings, ProviderDriverKind, type ModelCapabilities } from "@t3tools/contracts";

import { createModelCapabilities } from "@t3tools/shared/model";
import { buildServerProvider, providerModelsFromSettings, type ServerProviderDraft } from "../providerSnapshot.js";
import { ollamaListModels, ollamaVersion } from "../ollamaRuntime.js";

const PROVIDER = ProviderDriverKind.make("ollama");
const OLLAMA_PRESENTATION = { displayName: "Ollama", showInteractionModeToggle: false } as const;
const DEFAULT_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

export const makePendingOllamaProvider = (
  ollamaSettings: OllamaSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = providerModelsFromSettings([], PROVIDER, ollamaSettings.customModels, DEFAULT_CAPABILITIES);
    if (!ollamaSettings.enabled) {
      return buildServerProvider({ presentation: OLLAMA_PRESENTATION, enabled: false, checkedAt, models, probe: { installed: false, version: null, status: "warning", auth: { status: "unknown" }, message: "Ollama is disabled." } });
    }
    return buildServerProvider({ presentation: OLLAMA_PRESENTATION, enabled: true, checkedAt, models, probe: { installed: false, version: null, status: "warning", auth: { status: "unknown" }, message: "Ollama status has not been checked yet." } });
  });

export const checkOllamaProviderStatus = Effect.fn("checkOllamaProviderStatus")(function* (
  ollamaSettings: OllamaSettings,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const baseUrl = ollamaSettings.baseUrl;
  const apiKey = process.env.OLLAMA_API_KEY;
  const customModels = ollamaSettings.customModels;

  if (!ollamaSettings.enabled) {
    return buildServerProvider({ presentation: OLLAMA_PRESENTATION, enabled: false, checkedAt, models: providerModelsFromSettings([], PROVIDER, customModels, DEFAULT_CAPABILITIES), probe: { installed: false, version: null, status: "warning", auth: { status: "unknown" }, message: "Ollama is disabled." } });
  }

  const version = yield* ollamaVersion(baseUrl, apiKey);
  const modelsExit = yield* Effect.exit(ollamaListModels(baseUrl, apiKey));

  if (Exit.isFailure(modelsExit)) {
    const detail = Cause.isCause(modelsExit.cause) ? Cause.pretty(modelsExit.cause) : String(modelsExit.cause);
    return buildServerProvider({ presentation: OLLAMA_PRESENTATION, enabled: true, checkedAt, models: providerModelsFromSettings([], PROVIDER, customModels, DEFAULT_CAPABILITIES), probe: { installed: true, version: version || null, status: "error", auth: { status: "unknown" }, message: `Could not reach Ollama at ${baseUrl}: ${detail}` } });
  }

  const rawModels = modelsExit.value as ReadonlyArray<{ name: string }>;
  const remoteModels = rawModels.map((m) => ({ slug: m.name, name: m.name, isCustom: false, capabilities: DEFAULT_CAPABILITIES }));
  const finalModels = providerModelsFromSettings(remoteModels, PROVIDER, customModels, DEFAULT_CAPABILITIES);

  return buildServerProvider({ presentation: OLLAMA_PRESENTATION, enabled: true, checkedAt, models: finalModels, probe: { installed: true, version: version || null, status: "ready", auth: { status: "authenticated", type: "ollama" }, message: `${finalModels.length} model${finalModels.length === 1 ? "" : "s"} available via Ollama at ${baseUrl}.` } });
});