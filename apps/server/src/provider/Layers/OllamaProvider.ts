import type { OllamaSettings, ServerProviderModel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

export const OLLAMA_API_KEY_ENV = "OLLAMA_API_KEY";
export const OLLAMA_DEFAULT_HOST = "http://127.0.0.1:11434";
export type OllamaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class OllamaProbeError extends Schema.TaggedError<OllamaProbeError>()("OllamaProbeError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
export function ollamaApiUrl(host: string, path: string): string {
  const base = (host.trim() || OLLAMA_DEFAULT_HOST).replace(/\/+$/, "");
  return `${base}${base.endsWith("/api") ? "" : "/api"}${path}`;
}
function authHeaders(
  settings: OllamaSettings,
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const key = settings.apiKey.trim() || environment[OLLAMA_API_KEY_ENV]?.trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}
const emptyCapabilities = { optionDescriptors: [] } as const;
const OLLAMA_PROBE_TIMEOUT = "10 seconds";
const isOllamaProbeError = Schema.is(OllamaProbeError);

export function probeOllama(
  settings: OllamaSettings,
  environment: NodeJS.ProcessEnv,
  fetchImpl: OllamaFetch = fetch,
) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchImpl(ollamaApiUrl(settings.host, "/tags"), {
        headers: authHeaders(settings, environment),
        signal,
      });
      if (!response.ok) throw new OllamaProbeError({ detail: `HTTP ${response.status}` });
      const body = (await response.json()) as {
        models?: Array<{ name?: unknown; details?: { family?: unknown } }>;
      };
      const models: ServerProviderModel[] = (body.models ?? []).flatMap((model) => {
        if (typeof model.name !== "string" || !model.name.trim()) return [];
        const slug = model.name.trim();
        return [
          {
            slug,
            name:
              typeof model.details?.family === "string"
                ? `${slug} (${model.details.family})`
                : slug,
            isCustom: false,
            capabilities: emptyCapabilities,
          },
        ];
      });
      return {
        models: providerModelsFromSettings(models, settings.customModels, emptyCapabilities),
        version: null as string | null,
      };
    },
    catch: (cause) =>
      isOllamaProbeError(cause)
        ? cause
        : new OllamaProbeError({ detail: "Ollama request failed.", cause }),
  });
}

const PRESENTATION = { displayName: "Ollama", supportsConversationRollback: false } as const;
export function buildInitialOllamaProviderSnapshot(
  settings: OllamaSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const fallback: ServerProviderModel[] = settings.defaultModel.trim()
      ? [
          {
            slug: settings.defaultModel.trim(),
            name: settings.defaultModel.trim(),
            isCustom: false,
            capabilities: emptyCapabilities,
          },
        ]
      : [];
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: providerModelsFromSettings(fallback, settings.customModels, emptyCapabilities),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Ollama availability..."
          : "Ollama is disabled in T3 Code settings.",
      },
    });
  });
}
export function checkOllamaProviderStatus(
  settings: OllamaSettings,
  environment: NodeJS.ProcessEnv,
  fetchImpl: OllamaFetch = fetch,
) {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    if (!settings.enabled) return yield* buildInitialOllamaProviderSnapshot(settings);
    const result = yield* Effect.result(
      probeOllama(settings, environment, fetchImpl).pipe(
        Effect.timeoutOption(OLLAMA_PROBE_TIMEOUT),
      ),
    );
    if (result._tag === "Failure" || result.success._tag === "None")
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message:
            result._tag === "Failure"
              ? `Ollama is unavailable at ${settings.host}.`
              : `Ollama did not respond within ${OLLAMA_PROBE_TIMEOUT}.`,
        },
      });
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: result.success.value.models,
      probe: {
        installed: true,
        version: result.success.value.version,
        status: "ready",
        auth: { status: "unknown" },
      },
    });
  });
}
