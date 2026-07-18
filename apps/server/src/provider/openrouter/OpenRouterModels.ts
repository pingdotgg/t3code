import {
  type ModelCapabilities,
  type OpenRouterSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { DEFAULT_TIMEOUT_MS } from "../providerSnapshot.ts";
import { DEFAULT_OPENROUTER_MODEL, openRouterModelsUrl } from "./OpenRouterRuntime.ts";

export const EMPTY_OPENROUTER_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export const FALLBACK_OPENROUTER_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEFAULT_OPENROUTER_MODEL,
    name: "Claude Sonnet 4",
    isCustom: false,
    capabilities: EMPTY_OPENROUTER_CAPABILITIES,
  },
  {
    slug: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    isCustom: false,
    capabilities: EMPTY_OPENROUTER_CAPABILITIES,
  },
  {
    slug: "openai/gpt-4o",
    name: "GPT-4o",
    isCustom: false,
    capabilities: EMPTY_OPENROUTER_CAPABILITIES,
  },
];

const OpenRouterModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
    }),
  ),
});

const decodeOpenRouterModelsResponse = Schema.decodeUnknownEffect(OpenRouterModelsResponse);
const MAX_DISCOVERED_MODELS = 200;

export type OpenRouterModelFetchResult =
  | {
      readonly ok: true;
      readonly models: ReadonlyArray<ServerProviderModel>;
    }
  | {
      readonly ok: false;
      readonly authFailed: boolean;
      readonly message: string;
    };

export const fetchOpenRouterModels = Effect.fn("fetchOpenRouterModels")(function* (
  settings: OpenRouterSettings,
): Effect.fn.Return<OpenRouterModelFetchResult, never, HttpClient.HttpClient> {
  const apiKey = settings.apiKey.trim();
  if (apiKey.length === 0) {
    return {
      ok: false,
      authFailed: true,
      message: "Add an OpenRouter API key in provider settings.",
    };
  }

  const httpClient = yield* HttpClient.HttpClient;
  const url = openRouterModelsUrl(settings.baseUrl);

  // Timeout covers both headers and body consumption so a stalling response
  // body cannot hang the provider status refresh indefinitely.
  const fetchResult = yield* Effect.gen(function* () {
    const httpResponse = yield* HttpClientRequest.get(url).pipe(
      HttpClientRequest.bearerToken(apiKey),
      HttpClientRequest.acceptJson,
      httpClient.execute,
    );

    if (httpResponse.status === 401 || httpResponse.status === 403) {
      return {
        ok: false as const,
        authFailed: true,
        message: "OpenRouter API key is missing or invalid.",
      } satisfies OpenRouterModelFetchResult;
    }

    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return {
        ok: false as const,
        authFailed: false,
        message: `OpenRouter models API returned HTTP ${httpResponse.status}.`,
      } satisfies OpenRouterModelFetchResult;
    }

    const body = yield* httpResponse.json.pipe(Effect.result);
    if (Result.isFailure(body)) {
      return {
        ok: false as const,
        authFailed: false,
        message: "OpenRouter models API returned an unreadable response.",
      } satisfies OpenRouterModelFetchResult;
    }

    const decoded = yield* decodeOpenRouterModelsResponse(body.success).pipe(Effect.result);
    if (Result.isFailure(decoded)) {
      return {
        ok: false as const,
        authFailed: false,
        message: "OpenRouter models API returned an unexpected payload.",
      } satisfies OpenRouterModelFetchResult;
    }

    const models = decoded.success.data
      .filter((model) => model.id.trim().length > 0)
      .slice(0, MAX_DISCOVERED_MODELS)
      .map(
        (model): ServerProviderModel => ({
          slug: model.id,
          name: model.name?.trim() || model.id,
          isCustom: false,
          capabilities: EMPTY_OPENROUTER_CAPABILITIES,
        }),
      );

    if (models.length === 0) {
      return {
        ok: false as const,
        authFailed: false,
        message: "OpenRouter returned an empty model catalog.",
      } satisfies OpenRouterModelFetchResult;
    }

    return { ok: true as const, models } satisfies OpenRouterModelFetchResult;
  }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(fetchResult)) {
    return {
      ok: false,
      authFailed: false,
      message: "Failed to reach OpenRouter models API.",
    };
  }

  if (Option.isNone(fetchResult.success)) {
    return {
      ok: false,
      authFailed: false,
      message: "Timed out while fetching OpenRouter models.",
    };
  }

  return fetchResult.success.value;
});
