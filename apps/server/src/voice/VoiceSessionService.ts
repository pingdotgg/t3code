import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  VoiceApiError,
  type VoiceCredentialStatus,
  type VoiceRealtimeModel,
  type VoiceSessionAccess,
  type VoiceWebExtractInput,
  type VoiceWebExtractResult,
  type VoiceWebSearchInput,
  type VoiceWebSearchResult,
} from "@t3tools/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const OPENAI_REALTIME_API_KEY_SECRET = "openai-realtime-api-key";
const LEGACY_XAI_VOICE_API_KEY_SECRET = "xai-voice-api-key";
const PARALLEL_API_KEY_SECRET = "parallel-api-key";
const OPENAI_CLIENT_SECRET_URL = "https://api.openai.com/v1/realtime/client_secrets";
const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime/calls";
const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";
const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";
const OpenAIClientSecretResponse = Schema.Struct({
  value: Schema.String,
  expires_at: Schema.Number,
});

const ParallelSourceResponse = Schema.Struct({
  url: Schema.String,
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  publish_date: Schema.optionalKey(Schema.NullOr(Schema.String)),
  excerpts: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ParallelSearchResponse = Schema.Struct({
  search_id: Schema.String,
  session_id: Schema.optionalKey(Schema.String),
  results: Schema.Array(ParallelSourceResponse),
});

const ParallelExtractResponse = Schema.Struct({
  extract_id: Schema.String,
  session_id: Schema.optionalKey(Schema.String),
  results: Schema.Array(ParallelSourceResponse),
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        url: Schema.String,
        error_type: Schema.String,
        http_status_code: Schema.optionalKey(Schema.Number),
        content: Schema.String,
      }),
    ),
  ),
});

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function secretStoreFailure(provider: "OpenAI Realtime" | "Parallel"): VoiceApiError {
  return new VoiceApiError({
    reason: "secret_store_failed",
    message: `T3 Code could not access the saved ${provider} credential.`,
  });
}

function parallelHttpError(status: number): VoiceApiError {
  const invalidCredential = status === 401 || status === 403;
  return new VoiceApiError({
    reason: invalidCredential ? "parallel_credential_invalid" : "web_tool_unavailable",
    message: invalidCredential
      ? "Parallel rejected this API key. Check the key and its workspace permissions."
      : `Parallel could not complete the web request (HTTP ${status}).`,
  });
}

function validateSearchQueries(searchQueries: ReadonlyArray<string>): VoiceApiError | null {
  return searchQueries.length >= 1 && searchQueries.length <= 5
    ? null
    : new VoiceApiError({
        reason: "invalid_web_tool_request",
        message: "Parallel Search requires between 1 and 5 search queries.",
      });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function mapParallelSource(source: typeof ParallelSourceResponse.Type) {
  return {
    url: source.url,
    ...(source.title !== undefined ? { title: source.title } : {}),
    ...(source.publish_date !== undefined ? { publishDate: source.publish_date } : {}),
    excerpts: source.excerpts ?? [],
  };
}

export class VoiceSessionService extends Context.Service<
  VoiceSessionService,
  {
    readonly getCredentialStatus: Effect.Effect<VoiceCredentialStatus, VoiceApiError>;
    readonly setCredential: (apiKey: string) => Effect.Effect<VoiceCredentialStatus, VoiceApiError>;
    readonly removeCredential: Effect.Effect<VoiceCredentialStatus, VoiceApiError>;
    readonly createSession: (
      model: VoiceRealtimeModel,
    ) => Effect.Effect<VoiceSessionAccess, VoiceApiError>;
    readonly getParallelCredentialStatus: Effect.Effect<VoiceCredentialStatus, VoiceApiError>;
    readonly setParallelCredential: (
      apiKey: string,
    ) => Effect.Effect<VoiceCredentialStatus, VoiceApiError>;
    readonly removeParallelCredential: Effect.Effect<VoiceCredentialStatus, VoiceApiError>;
    readonly searchWeb: (
      input: VoiceWebSearchInput,
    ) => Effect.Effect<VoiceWebSearchResult, VoiceApiError>;
    readonly extractWeb: (
      input: VoiceWebExtractInput,
    ) => Effect.Effect<VoiceWebExtractResult, VoiceApiError>;
  }
>()("t3/voice/VoiceSessionService") {}

export const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;

  // The old provider credential has no consumer after this migration. Remove it
  // during service startup so upgrading does not leave an unused xAI key behind.
  yield* secretStore.remove(LEGACY_XAI_VOICE_API_KEY_SECRET).pipe(Effect.catch(() => Effect.void));

  const readCredential = secretStore.get(OPENAI_REALTIME_API_KEY_SECRET).pipe(
    Effect.mapError(() => secretStoreFailure("OpenAI Realtime")),
    Effect.map(Option.map(bytesToString)),
  );
  const readParallelCredential = secretStore.get(PARALLEL_API_KEY_SECRET).pipe(
    Effect.mapError(() => secretStoreFailure("Parallel")),
    Effect.map(Option.map(bytesToString)),
  );

  const getCredentialStatus = readCredential.pipe(
    Effect.map((credential) => ({ configured: Option.isSome(credential) })),
    Effect.withSpan("VoiceSessionService.getCredentialStatus"),
  );

  const setCredential: VoiceSessionService["Service"]["setCredential"] = Effect.fn(
    "VoiceSessionService.setCredential",
  )(function* (apiKey) {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) {
      return yield* new VoiceApiError({
        reason: "credential_invalid",
        message: "Enter a non-empty OpenAI API key.",
      });
    }
    yield* secretStore
      .set(OPENAI_REALTIME_API_KEY_SECRET, stringToBytes(trimmed))
      .pipe(Effect.mapError(() => secretStoreFailure("OpenAI Realtime")));
    return { configured: true };
  });

  const removeCredential = secretStore.remove(OPENAI_REALTIME_API_KEY_SECRET).pipe(
    Effect.mapError(() => secretStoreFailure("OpenAI Realtime")),
    Effect.as({ configured: false }),
    Effect.withSpan("VoiceSessionService.removeCredential"),
  );

  const createSession: VoiceSessionService["Service"]["createSession"] = Effect.fn(
    "VoiceSessionService.createSession",
  )(function* (model) {
    const credential = yield* readCredential;
    if (Option.isNone(credential)) {
      return yield* new VoiceApiError({
        reason: "credential_not_configured",
        message: "Add an OpenAI API key in Voice settings before starting a voice session.",
      });
    }

    const request = yield* HttpClientRequest.post(OPENAI_CLIENT_SECRET_URL).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${credential.value}`),
      HttpClientRequest.setHeader("content-type", "application/json"),
      HttpClientRequest.bodyJson({
        expires_after: { anchor: "created_at", seconds: 600 },
        session: {
          type: "realtime",
          model,
          audio: {
            input: {
              turn_detection: {
                type: "server_vad",
                create_response: false,
                interrupt_response: true,
              },
            },
          },
        },
      }),
      Effect.mapError(
        () =>
          new VoiceApiError({
            reason: "upstream_unavailable",
            message: "T3 Code could not prepare the OpenAI Realtime request.",
          }),
      ),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.mapError(
        () =>
          new VoiceApiError({
            reason: "upstream_unavailable",
            message: "T3 Code could not reach the OpenAI Realtime API.",
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new VoiceApiError({
        reason:
          response.status === 401 || response.status === 403
            ? "credential_invalid"
            : "upstream_unavailable",
        message:
          response.status === 401 || response.status === 403
            ? "OpenAI rejected this API key. Check the key and its project permissions."
            : `OpenAI could not create a Realtime session (HTTP ${response.status}).`,
      });
    }

    const result = yield* HttpClientResponse.schemaBodyJson(OpenAIClientSecretResponse)(
      response,
    ).pipe(
      Effect.mapError(
        () =>
          new VoiceApiError({
            reason: "upstream_unavailable",
            message: "OpenAI returned an invalid Realtime session credential.",
          }),
      ),
    );
    return {
      clientSecret: result.value,
      expiresAt: result.expires_at,
      realtimeUrl: OPENAI_REALTIME_URL,
    };
  });

  const getParallelCredentialStatus = readParallelCredential.pipe(
    Effect.map((credential) => ({ configured: Option.isSome(credential) })),
    Effect.withSpan("VoiceSessionService.getParallelCredentialStatus"),
  );

  const setParallelCredential: VoiceSessionService["Service"]["setParallelCredential"] = Effect.fn(
    "VoiceSessionService.setParallelCredential",
  )(function* (apiKey) {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) {
      return yield* new VoiceApiError({
        reason: "parallel_credential_invalid",
        message: "Enter a non-empty Parallel API key.",
      });
    }
    yield* secretStore
      .set(PARALLEL_API_KEY_SECRET, stringToBytes(trimmed))
      .pipe(Effect.mapError(() => secretStoreFailure("Parallel")));
    return { configured: true };
  });

  const removeParallelCredential = secretStore.remove(PARALLEL_API_KEY_SECRET).pipe(
    Effect.mapError(() => secretStoreFailure("Parallel")),
    Effect.as({ configured: false }),
    Effect.withSpan("VoiceSessionService.removeParallelCredential"),
  );

  const searchWeb: VoiceSessionService["Service"]["searchWeb"] = Effect.fn(
    "VoiceSessionService.searchWeb",
  )(function* (input) {
    const credential = yield* readParallelCredential;
    if (Option.isNone(credential)) {
      return yield* new VoiceApiError({
        reason: "parallel_credential_not_configured",
        message: "Add a Parallel API key in Voice settings before searching the web.",
      });
    }
    const queryError = validateSearchQueries(input.searchQueries);
    if (queryError) return yield* queryError;

    const request = yield* HttpClientRequest.post(PARALLEL_SEARCH_URL).pipe(
      HttpClientRequest.setHeader("x-api-key", credential.value),
      HttpClientRequest.setHeader("content-type", "application/json"),
      HttpClientRequest.bodyJson({
        objective: input.objective,
        search_queries: input.searchQueries,
        mode: "basic",
        max_chars_total: 12_000,
        client_model: "gpt-realtime-2.1-mini",
      }),
      Effect.mapError(
        () =>
          new VoiceApiError({
            reason: "invalid_web_tool_request",
            message: "T3 Code could not prepare the Parallel Search request.",
          }),
      ),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.mapError(
        () =>
          new VoiceApiError({
            reason: "web_tool_unavailable",
            message: "T3 Code could not reach Parallel Search.",
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* parallelHttpError(response.status);
    }
    const result = yield* HttpClientResponse.schemaBodyJson(ParallelSearchResponse)(response).pipe(
      Effect.mapError(
        () =>
          new VoiceApiError({
            reason: "web_tool_unavailable",
            message: "Parallel Search returned an invalid response.",
          }),
      ),
    );
    return {
      searchId: result.search_id,
      sessionId: result.session_id ?? result.search_id,
      results: result.results.map(mapParallelSource),
    };
  });

  const extractWeb: VoiceSessionService["Service"]["extractWeb"] = Effect.fn(
    "VoiceSessionService.extractWeb",
  )(function* (input) {
    const credential = yield* readParallelCredential;
    if (Option.isNone(credential)) {
      return yield* new VoiceApiError({
        reason: "parallel_credential_not_configured",
        message: "Add a Parallel API key in Voice settings before extracting web pages.",
      });
    }
    if (
      input.urls.length < 1 ||
      input.urls.length > 20 ||
      input.urls.some((url) => !isHttpUrl(url))
    ) {
      return yield* new VoiceApiError({
        reason: "invalid_web_tool_request",
        message: "Parallel Extract requires between 1 and 20 valid HTTP or HTTPS URLs.",
      });
    }
    if (input.searchQueries) {
      const queryError = validateSearchQueries(input.searchQueries);
      if (queryError) return yield* queryError;
    }

    const request = yield* HttpClientRequest.post(PARALLEL_EXTRACT_URL).pipe(
      HttpClientRequest.setHeader("x-api-key", credential.value),
      HttpClientRequest.setHeader("content-type", "application/json"),
      HttpClientRequest.bodyJson({
        urls: input.urls,
        ...(input.objective ? { objective: input.objective } : {}),
        ...(input.searchQueries ? { search_queries: input.searchQueries } : {}),
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        max_chars_total: 20_000,
        client_model: "gpt-realtime-2.1-mini",
      }),
      Effect.mapError(
        () =>
          new VoiceApiError({
            reason: "invalid_web_tool_request",
            message: "T3 Code could not prepare the Parallel Extract request.",
          }),
      ),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.mapError(
        () =>
          new VoiceApiError({
            reason: "web_tool_unavailable",
            message: "T3 Code could not reach Parallel Extract.",
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* parallelHttpError(response.status);
    }
    const result = yield* HttpClientResponse.schemaBodyJson(ParallelExtractResponse)(response).pipe(
      Effect.mapError(
        () =>
          new VoiceApiError({
            reason: "web_tool_unavailable",
            message: "Parallel Extract returned an invalid response.",
          }),
      ),
    );
    return {
      extractId: result.extract_id,
      sessionId: result.session_id ?? input.sessionId ?? result.extract_id,
      results: result.results.map(mapParallelSource),
      errors: (result.errors ?? []).map((error) => ({
        url: error.url,
        error: `${error.error_type}${error.http_status_code ? ` (HTTP ${error.http_status_code})` : ""}: ${error.content}`,
      })),
    };
  });

  return {
    getCredentialStatus,
    setCredential,
    removeCredential,
    createSession,
    getParallelCredentialStatus,
    setParallelCredential,
    removeParallelCredential,
    searchWeb,
    extractWeb,
  } satisfies VoiceSessionService["Service"];
});

export const layer = Layer.effect(VoiceSessionService, make);
