import { decodeSpeechPcmRequest } from "@t3tools/shared/speech";
import {
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  EnvironmentVoiceBodyLimit,
  SPEECH_MAX_OPTIONS_BYTES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SpeechService from "./SpeechService.ts";
import * as SpeechPostProcessing from "./postProcessing.ts";

const bodyLimit = Layer.succeed(EnvironmentVoiceBodyLimit, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const length = Number(request.headers["content-length"]);
    if (length > SpeechService.MAX_SPEECH_BYTES + SPEECH_MAX_OPTIONS_BYTES + 4)
      return yield* failEnvironmentInvalidRequest("invalid_audio");
    return yield* effect.pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        ByteSize.bytes(SpeechService.MAX_SPEECH_BYTES + SPEECH_MAX_OPTIONS_BYTES + 4),
      ),
    );
  }),
);

export const speechHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const speech = yield* SpeechService.SpeechService;
    const postProcessing = yield* SpeechPostProcessing.SpeechPostProcessing;
    return handlers
      .handle(
        "prepareModel",
        Effect.fn("environment.voice.prepareModel")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* speech.prepareModel.pipe(
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
        }),
      )
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
          return yield* speech.downloadModel(args.payload.modelId).pipe(
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
        }),
      )
      .handle(
        "selectModel",
        Effect.fn("environment.voice.selectModel")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* speech.selectModel(args.payload.modelId).pipe(
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
        }),
      )
      .handle(
        "cancelModelDownload",
        Effect.fn("environment.voice.cancelModelDownload")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* speech
            .cancelDownload(args.payload.modelId)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }),
      )
      .handle(
        "updateAcceleration",
        Effect.fn("environment.voice.updateAcceleration")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* speech.updateAcceleration(args.payload.acceleration).pipe(
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
        }),
      )
      .handle(
        "updateModelUnloadTimeout",
        Effect.fn("environment.voice.updateModelUnloadTimeout")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* speech
            .updateModelUnloadTimeout(args.payload.timeout)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }),
      )
      .handle(
        "postProcess",
        Effect.fn("environment.voice.postProcess")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* postProcessing
            .process(args.payload)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }),
      )
      .handle(
        "transcribe",
        Effect.fn("environment.voice.transcribe")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const decoded = yield* Effect.try({
            try: () => decodeSpeechPcmRequest(args.payload),
            catch: () =>
              new SpeechService.SpeechInvalidAudioError({
                byteLength: args.payload.byteLength,
                message: "Invalid speech options.",
              }),
          }).pipe(Effect.catch(() => failEnvironmentInvalidRequest("invalid_audio")));
          const text = yield* speech.transcribe(decoded.pcm, decoded.options).pipe(
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
          return yield* speech.removeModel(args.payload.modelId).pipe(
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
        }),
      );
  }),
).pipe(Layer.provide(bodyLimit), Layer.provide(SpeechPostProcessing.layer));
