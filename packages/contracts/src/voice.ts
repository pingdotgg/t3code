import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OPENAI_REALTIME_MODEL = "gpt-realtime-2.1" as const;
export const DEFAULT_REALTIME_VOICE = "marin" as const;

export const REALTIME_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;

export const RealtimeVoice = Schema.Literals(REALTIME_VOICES);
export type RealtimeVoice = typeof RealtimeVoice.Type;

export const VoiceOpenAiApiKey = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
export type VoiceOpenAiApiKey = typeof VoiceOpenAiApiKey.Type;

export const VoiceCredentialSource = Schema.Literals(["stored", "environment"]);
export type VoiceCredentialSource = typeof VoiceCredentialSource.Type;

export const VoiceCredentialStatus = Schema.Union([
  Schema.Struct({
    configured: Schema.Literal(false),
    source: Schema.Null,
  }),
  Schema.Struct({
    configured: Schema.Literal(true),
    source: VoiceCredentialSource,
  }),
]);
export type VoiceCredentialStatus = typeof VoiceCredentialStatus.Type;

export const VoiceCredentialMutation = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("set"),
    apiKey: VoiceOpenAiApiKey,
  }),
  Schema.Struct({
    action: Schema.Literal("remove"),
  }),
]);
export type VoiceCredentialMutation = typeof VoiceCredentialMutation.Type;

export const VoiceRealtimeClientSecretRequest = Schema.Struct({
  voice: Schema.optionalKey(RealtimeVoice),
});
export type VoiceRealtimeClientSecretRequest = typeof VoiceRealtimeClientSecretRequest.Type;

export const VoiceRealtimeClientSecret = Schema.Struct({
  clientSecret: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  expiresAt: PositiveInt,
  sessionId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type VoiceRealtimeClientSecret = typeof VoiceRealtimeClientSecret.Type;

const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

export const EnvironmentVoiceUnavailableReason = Schema.Literals([
  "not_configured",
  "credential_rejected",
  "model_unavailable",
]);
export type EnvironmentVoiceUnavailableReason = typeof EnvironmentVoiceUnavailableReason.Type;

export class EnvironmentVoiceUnavailableError extends Schema.TaggedErrorClass<EnvironmentVoiceUnavailableError>()(
  "EnvironmentVoiceUnavailableError",
  {
    code: Schema.Literal("voice_unavailable"),
    reason: EnvironmentVoiceUnavailableReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentVoiceUnavailableError)(this, {
      status: 503,
      headers: NO_STORE_HEADERS,
    });
  }
}

export const EnvironmentVoiceRateLimitedReason = Schema.Literals([
  "local_rate_limit",
  "local_concurrency",
  "upstream_rate_limit",
]);
export type EnvironmentVoiceRateLimitedReason = typeof EnvironmentVoiceRateLimitedReason.Type;

export class EnvironmentVoiceRateLimitedError extends Schema.TaggedErrorClass<EnvironmentVoiceRateLimitedError>()(
  "EnvironmentVoiceRateLimitedError",
  {
    code: Schema.Literal("rate_limited"),
    reason: EnvironmentVoiceRateLimitedReason,
    retryAfterSeconds: PositiveInt,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 429 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentVoiceRateLimitedError)(this, {
      status: 429,
      headers: {
        ...NO_STORE_HEADERS,
        "retry-after": String(this.retryAfterSeconds),
      },
    });
  }
}

export const EnvironmentVoiceUpstreamReason = Schema.Literals([
  "request_failed",
  "upstream_unavailable",
  "invalid_response",
]);
export type EnvironmentVoiceUpstreamReason = typeof EnvironmentVoiceUpstreamReason.Type;

export class EnvironmentVoiceUpstreamError extends Schema.TaggedErrorClass<EnvironmentVoiceUpstreamError>()(
  "EnvironmentVoiceUpstreamError",
  {
    code: Schema.Literal("voice_upstream_error"),
    reason: EnvironmentVoiceUpstreamReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentVoiceUpstreamError)(this, {
      status: 502,
      headers: NO_STORE_HEADERS,
    });
  }
}

export class EnvironmentVoiceTimeoutError extends Schema.TaggedErrorClass<EnvironmentVoiceTimeoutError>()(
  "EnvironmentVoiceTimeoutError",
  {
    code: Schema.Literal("voice_timeout"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 504 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentVoiceTimeoutError)(this, {
      status: 504,
      headers: NO_STORE_HEADERS,
    });
  }
}

export const EnvironmentVoiceHttpError = Schema.Union([
  EnvironmentVoiceUnavailableError,
  EnvironmentVoiceRateLimitedError,
  EnvironmentVoiceUpstreamError,
  EnvironmentVoiceTimeoutError,
]);
export type EnvironmentVoiceHttpError = typeof EnvironmentVoiceHttpError.Type;
