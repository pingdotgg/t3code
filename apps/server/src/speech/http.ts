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
        "models",
        Effect.fn("environment.voice.models")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* speech.models.pipe(
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
        }),
      )
      .handle(
        "downloadModel",
        Effect.fn("environment.voice.downloadModel")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* speech.downloadModel(args.payload.modelId).pipe(
            Effect.catchTags({
              SpeechInvalidAudioError: () => failEnvironmentInvalidRequest("invalid_audio"),
              SpeechUnsupportedPlatformError: () =>
                failEnvironmentInvalidRequest("speech_unavailable"),
              SpeechBusyError: () => failEnvironmentInvalidRequest("speech_busy"),
              SpeechDownloadCancelledError: () => Effect.void,
              SpeechModelNotFoundError: () => failEnvironmentInvalidRequest("invalid_command"),
              SpeechOperationError: (error) => failEnvironmentInternal("internal_error", error),
            }),
          );
          return yield* speech.models.pipe(
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
        }),
      )
      .handle(
        "selectModel",
        Effect.fn("environment.voice.selectModel")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* speech.selectModel(args.payload.modelId).pipe(
            Effect.catchTags({
              SpeechInvalidAudioError: () => failEnvironmentInvalidRequest("invalid_audio"),
              SpeechUnsupportedPlatformError: () =>
                failEnvironmentInvalidRequest("speech_unavailable"),
              SpeechBusyError: () => failEnvironmentInvalidRequest("speech_busy"),
              SpeechDownloadCancelledError: () => failEnvironmentInvalidRequest("speech_busy"),
              SpeechModelNotFoundError: () => failEnvironmentInvalidRequest("invalid_command"),
              SpeechOperationError: (error) => failEnvironmentInternal("internal_error", error),
            }),
          );
          return yield* speech.models.pipe(
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
        }),
      )
      .handle(
        "cancelModelDownload",
        Effect.fn("environment.voice.cancelModelDownload")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* speech
            .cancelDownload(args.payload.modelId)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          return yield* speech.models.pipe(
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
              SpeechDownloadCancelledError: () => failEnvironmentInvalidRequest("speech_busy"),
              SpeechModelNotFoundError: () => failEnvironmentInvalidRequest("invalid_command"),
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
          yield* speech.removeModel(args.payload.modelId).pipe(
            Effect.catchTags({
              SpeechInvalidAudioError: () => failEnvironmentInvalidRequest("invalid_audio"),
              SpeechUnsupportedPlatformError: () =>
                failEnvironmentInvalidRequest("speech_unavailable"),
              SpeechBusyError: () => failEnvironmentInvalidRequest("speech_busy"),
              SpeechDownloadCancelledError: () => failEnvironmentInvalidRequest("speech_busy"),
              SpeechModelNotFoundError: () => failEnvironmentInvalidRequest("invalid_command"),
              SpeechOperationError: (error) => failEnvironmentInternal("internal_error", error),
            }),
          );
          return yield* speech.models.pipe(
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
        }),
      );
  }),
).pipe(Layer.provide(bodyLimit));
