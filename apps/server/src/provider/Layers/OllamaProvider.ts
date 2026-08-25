/**
 * OllamaProvider — provider snapshot logic for the Ollama local LLM server.
 *
 * Ollama exposes a REST API at `http://127.0.0.1:11434` by default. We probe
 * the server with `GET /api/tags` to discover installed models and check
 * server health. No CLI binary is involved — Ollama is an HTTP server.
 *
 * @module provider/Layers/OllamaProvider
 */
import type {
  ModelCapabilities,
  OllamaSettings,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { enrichProviderSnapshotWithVersionAdvisory, type ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const OLLAMA_PRESENTATION = {
  displayName: "Ollama",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 5_000;

// ── Ollama API response schemas ──────────────────────────────────────

const OllamaTagModel = Schema.Struct({
  name: Schema.String,
  model: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  digest: Schema.optional(Schema.String),
});
type OllamaTagModel = typeof OllamaTagModel.Type;

const OllamaTagsResponse = Schema.Struct({
  models: Schema.Array(OllamaTagModel),
});
type OllamaTagsResponse = typeof OllamaTagsResponse.Type;

const decodeOllamaTagsResponse = Schema.decodeUnknownEither(OllamaTagsResponse);

// ── Snapshot builders ────────────────────────────────────────────────

export function buildInitialOllamaProviderSnapshot(
  ollamaSettings: OllamaSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = ollamaModelsFromSettings(ollamaSettings.customModels);

    if (!ollamaSettings.enabled) {
      return buildServerProvider({
        presentation: OLLAMA_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Ollama is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OLLAMA_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Ollama server availability...",
      },
    });
  });
}

function ollamaModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  discoveredModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(discoveredModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function buildOllamaDiscoveredModels(
  tags: ReadonlyArray<OllamaTagModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return tags.flatMap((tag) => {
    const slug = tag.name.trim();
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

function resolveOllamaServerUrl(settings: OllamaSettings): string {
  const trimmed = settings.serverUrl.trim();
  return trimmed.length > 0 ? trimmed : "http://127.0.0.1:11434";
}

// ── Health check ──────────────────────────────────────────────────────

export const checkOllamaProviderStatus = Effect.fn("checkOllamaProviderStatus")(function* (
  ollamaSettings: OllamaSettings,
): Effect.fn.Return<ServerProviderDraft, never, HttpClient.HttpClient> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = ollamaModelsFromSettings(ollamaSettings.customModels);

  if (!ollamaSettings.enabled) {
    return buildServerProvider({
      presentation: OLLAMA_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Ollama is disabled in T3 Code settings.",
      },
    });
  }

  const serverUrl = resolveOllamaServerUrl(ollamaSettings);

  const tagsResult = yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(`${serverUrl}/api/tags`);
    const response = yield* client.execute(request).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.mapError((cause) => cause as unknown as Error),
    );
    if (response._tag === "None") {
      return { _tag: "Timeout" as const };
    }
    const httpResponse = response.value;
    if (httpResponse.status !== 200) {
      return {
        _tag: "HttpError" as const,
        status: httpResponse.status,
      };
    }
    const bodyText = yield* HttpClientResponse.bodyToString(httpResponse);
    const parsed = decodeOllamaTagsResponse(JSON.parse(bodyText));
    if (parsed._tag === "Left") {
      return { _tag: "ParseError" as const };
    }
    return { _tag: "Success" as const, data: parsed.right };
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.succeed({
        _tag: "ConnectionError" as const,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
  );

  switch (tagsResult._tag) {
    case "ConnectionError":
      return buildServerProvider({
        presentation: OLLAMA_PRESENTATION,
        enabled: ollamaSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: `Cannot reach Ollama server at ${serverUrl}. Ensure Ollama is running.`,
        },
      });
    case "Timeout":
      return buildServerProvider({
        presentation: OLLAMA_PRESENTATION,
        enabled: ollamaSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: `Ollama server at ${serverUrl} timed out during health check.`,
        },
      });
    case "HttpError":
      return buildServerProvider({
        presentation: OLLAMA_PRESENTATION,
        enabled: ollamaSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: `Ollama server returned HTTP ${tagsResult.status} from /api/tags.`,
        },
      });
    case "ParseError":
      return buildServerProvider({
        presentation: OLLAMA_PRESENTATION,
        enabled: ollamaSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Ollama server responded with an unexpected model list format.",
        },
      });
    case "Success": {
      const discoveredModels = buildOllamaDiscoveredModels(tagsResult.data.models);
      const models = ollamaModelsFromSettings(ollamaSettings.customModels, discoveredModels);
      return buildServerProvider({
        presentation: OLLAMA_PRESENTATION,
        enabled: ollamaSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "unknown" },
        },
      });
    }
  }
});

// ── Enrichment ────────────────────────────────────────────────────────

export const enrichOllamaSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;
  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause(() => Effect.logWarning("Ollama version advisory enrichment failed").pipe(Effect.asVoid)),
    Effect.asVoid,
  );
};