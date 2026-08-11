import {
  OPENAI_REALTIME_MODEL,
  PositiveInt,
  TrimmedNonEmptyString,
  type AuthSessionId,
  type RealtimeVoice,
  type VoiceRealtimeClientSecret,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as RateLimiter from "effect/unstable/persistence/RateLimiter";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OpenAiRealtimeCredential from "./OpenAiRealtimeCredential.ts";

export const OPENAI_REALTIME_ORIGIN = "https://api.openai.com";
export const OPENAI_REALTIME_CLIENT_SECRET_URL = `${OPENAI_REALTIME_ORIGIN}/v1/realtime/client_secrets`;
export const OPENAI_REALTIME_CLIENT_SECRET_TTL_SECONDS = 60;
export const OPENAI_REALTIME_CLIENT_SECRET_EXPIRY_SKEW_SECONDS = 30;
export const OPENAI_REALTIME_REQUEST_TIMEOUT = Duration.seconds(10);
export const OPENAI_REALTIME_SESSION_RATE_LIMIT = 6;
export const OPENAI_REALTIME_GLOBAL_RATE_LIMIT = 30;
export const OPENAI_REALTIME_MAX_CONCURRENCY = 4;
export const OPENAI_REALTIME_SESSION_RATE_WINDOW = Duration.minutes(1);
export const OPENAI_REALTIME_SESSION_TRACKER_TTL = Duration.minutes(2);
export const OPENAI_REALTIME_MAX_TRACKED_SESSIONS = 256;

export class OpenAiRealtimeUnavailableError extends Schema.TaggedErrorClass<OpenAiRealtimeUnavailableError>()(
  "OpenAiRealtimeUnavailableError",
  {
    reason: Schema.Literals(["not_configured", "credential_rejected", "model_unavailable"]),
  },
) {}

export class OpenAiRealtimeRateLimitedError extends Schema.TaggedErrorClass<OpenAiRealtimeRateLimitedError>()(
  "OpenAiRealtimeRateLimitedError",
  {
    reason: Schema.Literals(["local_rate_limit", "local_concurrency", "upstream_rate_limit"]),
    retryAfterSeconds: PositiveInt,
  },
) {}

export class OpenAiRealtimeUpstreamError extends Schema.TaggedErrorClass<OpenAiRealtimeUpstreamError>()(
  "OpenAiRealtimeUpstreamError",
  {
    reason: Schema.Literals(["request_failed", "upstream_unavailable", "invalid_response"]),
  },
) {}

export class OpenAiRealtimeTimeoutError extends Schema.TaggedErrorClass<OpenAiRealtimeTimeoutError>()(
  "OpenAiRealtimeTimeoutError",
  {},
) {}

export class OpenAiRealtimeInternalError extends Schema.TaggedErrorClass<OpenAiRealtimeInternalError>()(
  "OpenAiRealtimeInternalError",
  {
    reason: Schema.Literals(["safety_identifier_failed", "rate_limiter_failed"]),
  },
) {}

export type OpenAiRealtimeMintError =
  | OpenAiRealtimeCredential.OpenAiRealtimeCredentialError
  | OpenAiRealtimeUnavailableError
  | OpenAiRealtimeRateLimitedError
  | OpenAiRealtimeUpstreamError
  | OpenAiRealtimeTimeoutError
  | OpenAiRealtimeInternalError;

const OpenAiRealtimeClientSecretResponse = Schema.Struct({
  value: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  expires_at: PositiveInt,
  session: Schema.Struct({
    type: Schema.Literal("realtime"),
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    model: Schema.Literal(OPENAI_REALTIME_MODEL),
  }),
});

export interface OpenAiRealtimeMintInput {
  readonly authSessionId: AuthSessionId;
  readonly voice: RealtimeVoice;
}

export class OpenAiRealtime extends Context.Service<
  OpenAiRealtime,
  {
    readonly mint: (
      input: OpenAiRealtimeMintInput,
    ) => Effect.Effect<VoiceRealtimeClientSecret, OpenAiRealtimeMintError>;
  }
>()("t3/voice/OpenAiRealtime") {}

const retryAfterSeconds = (duration: Duration.Duration): number =>
  Math.max(1, Math.ceil(Duration.toMillis(duration) / 1_000));

const upstreamRetryAfterSeconds = (value: string | undefined, nowMillis: number): number => {
  if (value === undefined) return 1;
  const parsed = Number.parseFloat(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(120, Math.ceil(parsed));
  return Option.match(DateTime.make(value), {
    onNone: () => 1,
    onSome: (retryAt) => {
      const delta = Math.ceil((DateTime.toEpochMillis(retryAt) - nowMillis) / 1_000);
      return delta > 0 ? Math.min(120, delta) : 1;
    },
  });
};

const failRateLimiter = (
  error: RateLimiter.RateLimiterError,
): Effect.Effect<never, OpenAiRealtimeRateLimitedError | OpenAiRealtimeInternalError> =>
  error.reason._tag === "RateLimitExceeded"
    ? Effect.fail(
        new OpenAiRealtimeRateLimitedError({
          reason: "local_rate_limit",
          retryAfterSeconds: retryAfterSeconds(error.reason.retryAfter),
        }),
      )
    : Effect.fail(new OpenAiRealtimeInternalError({ reason: "rate_limiter_failed" }));

interface SessionRateEntry {
  readonly attempts: ReadonlyArray<number>;
  readonly lastSeenAt: number;
}

export interface SessionMintRateLimiter {
  readonly consume: (
    authSessionId: AuthSessionId,
  ) => Effect.Effect<void, OpenAiRealtimeRateLimitedError>;
  readonly trackedSessionCount: Effect.Effect<number>;
}

export const makeSessionMintRateLimiter = (options?: {
  readonly limit?: number;
  readonly maxTrackedSessions?: number;
  readonly trackerTtl?: Duration.Input;
  readonly window?: Duration.Input;
}): Effect.Effect<SessionMintRateLimiter> =>
  Effect.gen(function* () {
    const limit = options?.limit ?? OPENAI_REALTIME_SESSION_RATE_LIMIT;
    const maxTrackedSessions = options?.maxTrackedSessions ?? OPENAI_REALTIME_MAX_TRACKED_SESSIONS;
    const trackerTtlMs = Duration.toMillis(
      options?.trackerTtl ?? OPENAI_REALTIME_SESSION_TRACKER_TTL,
    );
    const windowMs = Duration.toMillis(options?.window ?? OPENAI_REALTIME_SESSION_RATE_WINDOW);
    const entriesRef = yield* Ref.make(new Map<AuthSessionId, SessionRateEntry>());

    const consume: SessionMintRateLimiter["consume"] = (authSessionId) =>
      Effect.clockWith((clock) => {
        const now = clock.currentTimeMillisUnsafe();
        return Ref.modify(entriesRef, (current) => {
          const windowStart = now - windowMs;
          const entries = new Map<AuthSessionId, SessionRateEntry>();
          for (const [sessionId, entry] of current) {
            if (now - entry.lastSeenAt < trackerTtlMs) {
              entries.set(sessionId, {
                attempts: entry.attempts.filter((attemptedAt) => attemptedAt > windowStart),
                lastSeenAt: entry.lastSeenAt,
              });
            }
          }

          const previous = entries.get(authSessionId);
          const attempts = previous?.attempts ?? [];
          if (attempts.length >= limit) {
            entries.set(authSessionId, { attempts, lastSeenAt: now });
            const retryAfterSeconds = Math.max(
              1,
              Math.ceil(((attempts[0] ?? now) + windowMs - now) / 1_000),
            );
            return [retryAfterSeconds, entries] as const;
          }

          if (previous === undefined && entries.size >= maxTrackedSessions) {
            let safeEviction: AuthSessionId | undefined;
            let oldestSeenAt = Number.POSITIVE_INFINITY;
            for (const [sessionId, entry] of entries) {
              if (entry.attempts.length === 0 && entry.lastSeenAt < oldestSeenAt) {
                safeEviction = sessionId;
                oldestSeenAt = entry.lastSeenAt;
              }
            }
            if (safeEviction !== undefined) {
              entries.delete(safeEviction);
            } else {
              const earliestSafeSlotAt = Math.min(
                ...Array.from(entries.values(), (entry) => Math.max(...entry.attempts) + windowMs),
              );
              return [Math.max(1, Math.ceil((earliestSafeSlotAt - now) / 1_000)), entries] as const;
            }
          }

          entries.set(authSessionId, { attempts: [...attempts, now], lastSeenAt: now });
          return [undefined, entries] as const;
        }).pipe(
          Effect.flatMap((retryAfterSeconds) =>
            retryAfterSeconds === undefined
              ? Effect.void
              : Effect.fail(
                  new OpenAiRealtimeRateLimitedError({
                    reason: "local_rate_limit",
                    retryAfterSeconds,
                  }),
                ),
          ),
        );
      });

    return {
      consume,
      trackedSessionCount: Ref.get(entriesRef).pipe(Effect.map((entries) => entries.size)),
    };
  });

const decodeResponse = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.matchStatus({
    "2xx": (success) =>
      HttpClientResponse.schemaBodyJson(OpenAiRealtimeClientSecretResponse)(success).pipe(
        Effect.mapError(() => new OpenAiRealtimeUpstreamError({ reason: "invalid_response" })),
        Effect.flatMap((decoded) =>
          Effect.clockWith((clock) => {
            const nowSeconds = Math.floor(clock.currentTimeMillisUnsafe() / 1_000);
            return decoded.expires_at > nowSeconds &&
              decoded.expires_at <=
                nowSeconds +
                  OPENAI_REALTIME_CLIENT_SECRET_TTL_SECONDS +
                  OPENAI_REALTIME_CLIENT_SECRET_EXPIRY_SKEW_SECONDS
              ? Effect.succeed<VoiceRealtimeClientSecret>({
                  clientSecret: decoded.value,
                  expiresAt: decoded.expires_at,
                  sessionId: decoded.session.id,
                })
              : Effect.fail(new OpenAiRealtimeUpstreamError({ reason: "invalid_response" }));
          }),
        ),
      ),
    400: () => Effect.fail(new OpenAiRealtimeUnavailableError({ reason: "model_unavailable" })),
    401: () => Effect.fail(new OpenAiRealtimeUnavailableError({ reason: "credential_rejected" })),
    403: () => Effect.fail(new OpenAiRealtimeUnavailableError({ reason: "credential_rejected" })),
    404: () => Effect.fail(new OpenAiRealtimeUnavailableError({ reason: "model_unavailable" })),
    429: (limited) =>
      Effect.clockWith((clock) =>
        Effect.fail(
          new OpenAiRealtimeRateLimitedError({
            reason: "upstream_rate_limit",
            retryAfterSeconds: upstreamRetryAfterSeconds(
              limited.headers["retry-after"],
              clock.currentTimeMillisUnsafe(),
            ),
          }),
        ),
      ),
    "5xx": () => Effect.fail(new OpenAiRealtimeUpstreamError({ reason: "upstream_unavailable" })),
    orElse: () => Effect.fail(new OpenAiRealtimeUpstreamError({ reason: "request_failed" })),
  })(response);

export const make = Effect.gen(function* () {
  const credentials = yield* OpenAiRealtimeCredential.OpenAiRealtimeCredential;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const rateLimiter = yield* RateLimiter.RateLimiter;
  const concurrency = yield* Semaphore.make(OPENAI_REALTIME_MAX_CONCURRENCY);
  const sessionRateLimiter = yield* makeSessionMintRateLimiter();
  const environmentId = yield* environment.getEnvironmentId;
  const safetyIdentifier = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`t3-realtime:${environmentId}`))
    .pipe(
      Effect.map(Encoding.encodeHex),
      Effect.mapError(
        () => new OpenAiRealtimeInternalError({ reason: "safety_identifier_failed" }),
      ),
    );

  const consumeGlobalLimit = () =>
    rateLimiter
      .consume({
        algorithm: "token-bucket",
        key: "voice:client-secret:global",
        limit: OPENAI_REALTIME_GLOBAL_RATE_LIMIT,
        onExceeded: "fail",
        window: "1 minute",
      })
      .pipe(Effect.catchTags({ RateLimiterError: failRateLimiter }));

  const mint: OpenAiRealtime["Service"]["mint"] = Effect.fn("voice.openAiRealtime.mint")(
    function* (input) {
      yield* sessionRateLimiter.consume(input.authSessionId);
      yield* consumeGlobalLimit();

      const credential = yield* credentials.resolve;
      if (Option.isNone(credential)) {
        return yield* new OpenAiRealtimeUnavailableError({ reason: "not_configured" });
      }

      const request = HttpClientRequest.post(OPENAI_REALTIME_CLIENT_SECRET_URL).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(Redacted.value(credential.value.apiKey)),
        HttpClientRequest.setHeader("OpenAI-Safety-Identifier", safetyIdentifier),
        HttpClientRequest.bodyJson({
          expires_after: {
            anchor: "created_at",
            seconds: OPENAI_REALTIME_CLIENT_SECRET_TTL_SECONDS,
          },
          session: {
            type: "realtime",
            model: OPENAI_REALTIME_MODEL,
            audio: { output: { voice: input.voice } },
          },
        }),
        Effect.flatMap(httpClient.execute),
        Effect.mapError(() => new OpenAiRealtimeUpstreamError({ reason: "request_failed" })),
        Effect.flatMap(decodeResponse),
        Effect.timeoutOption(OPENAI_REALTIME_REQUEST_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () => Effect.fail(new OpenAiRealtimeTimeoutError()),
          }),
        ),
      );

      const result = yield* concurrency.withPermitsIfAvailable(1)(request);
      return yield* Option.match(result, {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.fail(
            new OpenAiRealtimeRateLimitedError({
              reason: "local_concurrency",
              retryAfterSeconds: 1,
            }),
          ),
      });
    },
  );

  return OpenAiRealtime.of({ mint });
});

export const layer = Layer.effect(OpenAiRealtime, make);

export const rateLimiterLayer = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));
