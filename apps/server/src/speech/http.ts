import {
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  EnvironmentVoiceBodyLimit,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SpeechService from "./SpeechService.ts";

const bodyLimit = Layer.succeed(EnvironmentVoiceBodyLimit, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const length = Number(request.headers["content-length"]);
    if (length > SpeechService.MAX_SPEECH_BYTES)
      return yield* failEnvironmentInvalidRequest("invalid_audio");
    return yield* effect.pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        FileSystem.Size(SpeechService.MAX_SPEECH_BYTES),
      ),
    );
  }),
);

export const speechHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const speech = yield* SpeechService.SpeechService;
    return handlers
      .handle(
        "status",
        Effect.fn("environment.voice.status")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* speech.status.pipe(
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
        }),
      )
      .handle(
        "transcribe",
        Effect.fn("environment.voice.transcribe")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          if (args.payload.byteLength > SpeechService.MAX_SPEECH_BYTES) {
            return yield* failEnvironmentInvalidRequest("invalid_audio");
          }
          const text = yield* speech.transcribe(args.payload).pipe(
            Effect.catchTags({
              SpeechInvalidAudioError: () => failEnvironmentInvalidRequest("invalid_audio"),
              SpeechUnsupportedPlatformError: () =>
                failEnvironmentInvalidRequest("speech_unavailable"),
              SpeechBusyError: () => failEnvironmentInvalidRequest("speech_busy"),
              SpeechOperationError: (error) => failEnvironmentInternal("internal_error", error),
            }),
          );
          return { text };
        }),
      )
      .handle(
        "removeModel",
        Effect.fn("environment.voice.removeModel")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* speech.removeModel.pipe(
            Effect.catchTags({
              SpeechInvalidAudioError: () => failEnvironmentInvalidRequest("invalid_audio"),
              SpeechUnsupportedPlatformError: () =>
                failEnvironmentInvalidRequest("speech_unavailable"),
              SpeechBusyError: () => failEnvironmentInvalidRequest("speech_busy"),
              SpeechOperationError: (error) => failEnvironmentInternal("internal_error", error),
            }),
          );
        }),
      );
  }),
).pipe(Layer.provide(bodyLimit));
