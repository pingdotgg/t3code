import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  DEFAULT_REALTIME_VOICE,
  EnvironmentHttpApi,
  EnvironmentVoiceRateLimitedError,
  EnvironmentVoiceTimeoutError,
  EnvironmentVoiceUnavailableError,
  EnvironmentVoiceUpstreamError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  appendEnvironmentNoStoreResponseHeaders,
  currentEnvironmentTraceId,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as OpenAiRealtime from "./OpenAiRealtime.ts";
import * as OpenAiRealtimeCredential from "./OpenAiRealtimeCredential.ts";

export const voiceNoStoreResponseLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.originalUrl.startsWith("/api/voice/")) {
        yield* appendEnvironmentNoStoreResponseHeaders;
      }
      return yield* httpEffect;
    }),
  { global: true },
);

const failVoiceUnavailable = (
  reason: "not_configured" | "credential_rejected" | "model_unavailable",
) =>
  currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentVoiceUnavailableError({ code: "voice_unavailable", reason, traceId }),
      ),
    ),
  );

const failVoiceRateLimited = (
  reason: "local_rate_limit" | "local_concurrency" | "upstream_rate_limit",
  retryAfterSeconds: number,
) =>
  Effect.gen(function* () {
    const traceId = yield* currentEnvironmentTraceId;
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(
        HttpServerResponse.setHeader(response, "retry-after", String(retryAfterSeconds)),
      ),
    );
    return yield* new EnvironmentVoiceRateLimitedError({
      code: "rate_limited",
      reason,
      retryAfterSeconds,
      traceId,
    });
  });

const failVoiceUpstream = (
  reason: "request_failed" | "upstream_unavailable" | "invalid_response",
) =>
  currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentVoiceUpstreamError({
          code: "voice_upstream_error",
          reason,
          traceId,
        }),
      ),
    ),
  );

const failVoiceTimeout = currentEnvironmentTraceId.pipe(
  Effect.flatMap((traceId) =>
    Effect.fail(new EnvironmentVoiceTimeoutError({ code: "voice_timeout", traceId })),
  ),
);

export const voiceHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const credential = yield* OpenAiRealtimeCredential.OpenAiRealtimeCredential;
    const realtime = yield* OpenAiRealtime.OpenAiRealtime;

    return handlers
      .handle(
        "credentialStatus",
        Effect.fn("environment.voice.credentialStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* appendEnvironmentNoStoreResponseHeaders;
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* credential.status.pipe(
            Effect.catchTag("OpenAiRealtimeCredentialError", (error) =>
              failEnvironmentInternal("voice_credential_load_failed", error),
            ),
          );
        }),
      )
      .handle(
        "updateCredential",
        Effect.fn("environment.voice.updateCredential")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* appendEnvironmentNoStoreResponseHeaders;
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          yield* (
            args.payload.action === "set"
              ? credential.set(Redacted.make(args.payload.apiKey))
              : credential.remove
          ).pipe(
            Effect.catchTag("OpenAiRealtimeCredentialError", (error) =>
              failEnvironmentInternal("voice_credential_update_failed", error),
            ),
          );
          return yield* credential.status.pipe(
            Effect.catchTag("OpenAiRealtimeCredentialError", (error) =>
              failEnvironmentInternal("voice_credential_load_failed", error),
            ),
          );
        }),
      )
      .handle(
        "clientSecret",
        Effect.fn("environment.voice.clientSecret")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* appendEnvironmentNoStoreResponseHeaders;
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* realtime
            .mint({
              authSessionId: principal.sessionId,
              voice: args.payload.voice ?? DEFAULT_REALTIME_VOICE,
            })
            .pipe(
              Effect.catchTags({
                OpenAiRealtimeCredentialError: (error) =>
                  failEnvironmentInternal("voice_session_issuance_failed", error),
                OpenAiRealtimeInternalError: (error) =>
                  failEnvironmentInternal("voice_session_issuance_failed", error),
                OpenAiRealtimeUnavailableError: (error) => failVoiceUnavailable(error.reason),
                OpenAiRealtimeRateLimitedError: (error) =>
                  failVoiceRateLimited(error.reason, error.retryAfterSeconds),
                OpenAiRealtimeUpstreamError: (error) => failVoiceUpstream(error.reason),
                OpenAiRealtimeTimeoutError: () => failVoiceTimeout,
              }),
            );
        }),
      );
  }),
);
