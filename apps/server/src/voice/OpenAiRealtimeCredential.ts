import type { VoiceCredentialSource, VoiceCredentialStatus } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const OPENAI_REALTIME_API_KEY_SECRET = "openai-realtime-api-key-v1";

export class OpenAiRealtimeCredentialError extends Schema.TaggedErrorClass<OpenAiRealtimeCredentialError>()(
  "OpenAiRealtimeCredentialError",
  {
    operation: Schema.Literals(["read", "write", "remove"]),
    reason: Schema.Literals([
      "secret_store_failed",
      "invalid_stored_value",
      "invalid_environment_value",
      "invalid_input",
    ]),
  },
) {
  override get message(): string {
    return `OpenAI Realtime credential ${this.operation} failed.`;
  }
}

export interface ResolvedOpenAiRealtimeCredential {
  readonly apiKey: Redacted.Redacted<string>;
  readonly source: VoiceCredentialSource;
}

const resolvedCredential = (
  apiKey: Redacted.Redacted<string>,
  source: VoiceCredentialSource,
): Option.Option<ResolvedOpenAiRealtimeCredential> => Option.some({ apiKey, source });

export class OpenAiRealtimeCredential extends Context.Service<
  OpenAiRealtimeCredential,
  {
    readonly status: Effect.Effect<VoiceCredentialStatus, OpenAiRealtimeCredentialError>;
    readonly resolve: Effect.Effect<
      Option.Option<ResolvedOpenAiRealtimeCredential>,
      OpenAiRealtimeCredentialError
    >;
    readonly set: (
      apiKey: Redacted.Redacted<string>,
    ) => Effect.Effect<void, OpenAiRealtimeCredentialError>;
    readonly remove: Effect.Effect<void, OpenAiRealtimeCredentialError>;
  }
>()("t3/voice/OpenAiRealtimeCredential") {}

const normalizeApiKey = (
  value: Redacted.Redacted<string>,
  operation: "read" | "write",
  reason: "invalid_stored_value" | "invalid_environment_value" | "invalid_input",
): Effect.Effect<Redacted.Redacted<string>, OpenAiRealtimeCredentialError> => {
  const normalized = Redacted.value(value).trim();
  return normalized.length > 0 && normalized.length <= 4_096
    ? Effect.succeed(Redacted.make(normalized))
    : Effect.fail(new OpenAiRealtimeCredentialError({ operation, reason }));
};

const decodeStoredApiKey = (bytes: Uint8Array) =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () =>
      new OpenAiRealtimeCredentialError({
        operation: "read",
        reason: "invalid_stored_value",
      }),
  }).pipe(
    Effect.flatMap((value) =>
      normalizeApiKey(Redacted.make(value), "read", "invalid_stored_value"),
    ),
  );

export const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const environmentApiKey = yield* Config.redacted("OPENAI_API_KEY").pipe(Config.option);

  const resolve: OpenAiRealtimeCredential["Service"]["resolve"] = secretStore
    .get(OPENAI_REALTIME_API_KEY_SECRET)
    .pipe(
      Effect.mapError(
        () =>
          new OpenAiRealtimeCredentialError({
            operation: "read",
            reason: "secret_store_failed",
          }),
      ),
      Effect.flatMap(
        Option.match({
          onSome: (bytes) =>
            decodeStoredApiKey(bytes).pipe(
              Effect.map((apiKey) => resolvedCredential(apiKey, "stored")),
            ),
          onNone: () =>
            Option.match(environmentApiKey, {
              onSome: (apiKey) =>
                normalizeApiKey(apiKey, "read", "invalid_environment_value").pipe(
                  Effect.map((normalized) => resolvedCredential(normalized, "environment")),
                ),
              onNone: () =>
                Effect.succeed<Option.Option<ResolvedOpenAiRealtimeCredential>>(Option.none()),
            }),
        }),
      ),
    );

  const status = resolve.pipe(
    Effect.map(
      Option.match({
        onSome: (credential): VoiceCredentialStatus => ({
          configured: true,
          source: credential.source,
        }),
        onNone: (): VoiceCredentialStatus => ({ configured: false, source: null }),
      }),
    ),
  );

  const set: OpenAiRealtimeCredential["Service"]["set"] = (apiKey) =>
    normalizeApiKey(apiKey, "write", "invalid_input").pipe(
      Effect.flatMap((normalized) =>
        secretStore.set(
          OPENAI_REALTIME_API_KEY_SECRET,
          new TextEncoder().encode(Redacted.value(normalized)),
        ),
      ),
      Effect.mapError((error) =>
        error._tag === "OpenAiRealtimeCredentialError"
          ? error
          : new OpenAiRealtimeCredentialError({
              operation: "write",
              reason: "secret_store_failed",
            }),
      ),
    );

  const remove: OpenAiRealtimeCredential["Service"]["remove"] = secretStore
    .remove(OPENAI_REALTIME_API_KEY_SECRET)
    .pipe(
      Effect.mapError(
        () =>
          new OpenAiRealtimeCredentialError({
            operation: "remove",
            reason: "secret_store_failed",
          }),
      ),
    );

  return OpenAiRealtimeCredential.of({ status, resolve, set, remove });
});

export const layer = Layer.effect(OpenAiRealtimeCredential, make);
