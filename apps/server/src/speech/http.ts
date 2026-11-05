import {
  AuthOrchestrationOperateScope,
  decodeSpeechProjectNameHeader,
  EnvironmentHttpApi,
  type EnvironmentInternalError,
  type EnvironmentRequestInvalidError,
  EnvironmentVoiceBodyLimit,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

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
        ByteSize.bytes(SpeechService.MAX_SPEECH_BYTES),
      ),
    );
  }),
);

const failSpeech = (
  error: SpeechService.SpeechError,
): Effect.Effect<never, EnvironmentRequestInvalidError | EnvironmentInternalError> => {
  switch (error._tag) {
    case "SpeechInvalidAudioError":
      return failEnvironmentInvalidRequest("invalid_audio");
    case "SpeechUnsupportedPlatformError":
      return failEnvironmentInvalidRequest("speech_unavailable");
    case "SpeechBusyError":
    case "SpeechDownloadCancelledError":
      return failEnvironmentInvalidRequest("speech_busy");
    case "SpeechModelNotFoundError":
      return failEnvironmentInvalidRequest("invalid_command");
    case "OpenRouterSpeechError":
      return failEnvironmentInvalidRequest(
        error.failure === "key_invalid"
          ? "speech_cloud_key_invalid"
          : error.failure === "credits"
            ? "speech_cloud_credits"
            : "speech_cloud_failed",
      );
    case "SpeechOperationError":
      return failEnvironmentInternal("internal_error", error);
  }
};

const failInternal = (error: unknown) => failEnvironmentInternal("internal_error", error);

export const speechHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const speech = yield* SpeechService.SpeechService;
    const authorize = (name: string) =>
      annotateEnvironmentRequest(name).pipe(
        Effect.andThen(requireEnvironmentScope(AuthOrchestrationOperateScope)),
      );
    return handlers
      .handle(
        "prepareModel",
        Effect.fn("environment.voice.prepareModel")(function* (args) {
          yield* authorize(args.endpoint.name);
          yield* speech.prepareModel.pipe(Effect.catch(failSpeech));
        }),
      )
      .handle(
        "status",
        Effect.fn("environment.voice.status")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech.status.pipe(Effect.catch(failInternal));
        }),
      )
      .handle(
        "models",
        Effect.fn("environment.voice.models")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech.models.pipe(Effect.catch(failInternal));
        }),
      )
      .handle(
        "downloadModel",
        Effect.fn("environment.voice.downloadModel")(function* (args) {
          yield* authorize(args.endpoint.name);
          yield* speech
            .downloadModel(args.payload.modelId)
            .pipe(
              Effect.catch((error) =>
                error._tag === "SpeechDownloadCancelledError" ? Effect.void : failSpeech(error),
              ),
            );
          return yield* speech.models.pipe(Effect.catch(failInternal));
        }),
      )
      .handle(
        "selectModel",
        Effect.fn("environment.voice.selectModel")(function* (args) {
          yield* authorize(args.endpoint.name);
          yield* speech.selectModel(args.payload.modelId).pipe(Effect.catch(failSpeech));
          return yield* speech.models.pipe(Effect.catch(failInternal));
        }),
      )
      .handle(
        "cancelModelDownload",
        Effect.fn("environment.voice.cancelModelDownload")(function* (args) {
          yield* authorize(args.endpoint.name);
          yield* speech.cancelDownload(args.payload.modelId).pipe(Effect.catch(failInternal));
          return yield* speech.models.pipe(Effect.catch(failInternal));
        }),
      )
      .handle(
        "updateCustomWords",
        Effect.fn("environment.voice.updateCustomWords")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech.updateCustomWords(args.payload.words).pipe(Effect.catch(failSpeech));
        }),
      )
      .handle(
        "updateModelDirectories",
        Effect.fn("environment.voice.updateModelDirectories")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech
            .updateModelDirectories(args.payload.directories)
            .pipe(Effect.catch(failSpeech));
        }),
      )
      .handle(
        "updateFillerWordRemoval",
        Effect.fn("environment.voice.updateFillerWordRemoval")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech
            .updateFillerWordRemoval(args.payload.enabled)
            .pipe(Effect.catch(failInternal));
        }),
      )
      .handle(
        "updateAcceleration",
        Effect.fn("environment.voice.updateAcceleration")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech
            .updateAcceleration(args.payload.acceleration)
            .pipe(Effect.catch(failSpeech));
        }),
      )
      .handle(
        "updateModelUnloadTimeout",
        Effect.fn("environment.voice.updateModelUnloadTimeout")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech
            .updateModelUnloadTimeout(args.payload.timeout)
            .pipe(Effect.catch(failInternal));
        }),
      )
      .handle(
        "updateLanguage",
        Effect.fn("environment.voice.updateLanguage")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech
            .updateLanguage(args.payload.language)
            .pipe(Effect.catch(failInternal));
        }),
      )
      .handle(
        "updateTranslation",
        Effect.fn("environment.voice.updateTranslation")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech
            .updateTranslation(args.payload.enabled)
            .pipe(Effect.catch(failInternal));
        }),
      )
      .handle(
        "postProcess",
        Effect.fn("environment.voice.postProcess")(function* (args) {
          yield* authorize(args.endpoint.name);
          const text = yield* speech.postProcess(args.payload).pipe(Effect.catch(failInternal));
          return { text };
        }),
      )
      .handle(
        "transcribe",
        Effect.fn("environment.voice.transcribe")(function* (args) {
          yield* authorize(args.endpoint.name);
          if (args.payload.byteLength > SpeechService.MAX_SPEECH_BYTES) {
            return yield* failEnvironmentInvalidRequest("invalid_audio");
          }
          const text = yield* speech
            .transcribe(
              args.payload,
              args.headers["x-t3-project-name"] === undefined
                ? undefined
                : decodeSpeechProjectNameHeader(args.headers["x-t3-project-name"]),
            )
            .pipe(Effect.catch(failSpeech));
          return { text };
        }),
      )
      .handle(
        "removeModel",
        Effect.fn("environment.voice.removeModel")(function* (args) {
          yield* authorize(args.endpoint.name);
          yield* speech.removeModel(args.payload.modelId).pipe(Effect.catch(failSpeech));
          return yield* speech.models.pipe(Effect.catch(failInternal));
        }),
      )
      .handle(
        "updateEngine",
        Effect.fn("environment.voice.updateEngine")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech.updateEngine(args.payload.engine).pipe(Effect.catch(failSpeech));
        }),
      )
      .handle(
        "cloudModels",
        Effect.fn("environment.voice.cloudModels")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech.cloudModels.pipe(Effect.catch(failSpeech));
        }),
      )
      .handle(
        "selectCloudModel",
        Effect.fn("environment.voice.selectCloudModel")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech
            .selectCloudModel(args.payload.modelId)
            .pipe(Effect.catch(failSpeech));
        }),
      )
      .handle(
        "saveCloudKey",
        Effect.fn("environment.voice.saveCloudKey")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech.saveCloudKey(args.payload.apiKey).pipe(Effect.catch(failSpeech));
        }),
      )
      .handle(
        "removeCloudKey",
        Effect.fn("environment.voice.removeCloudKey")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* speech.removeCloudKey.pipe(Effect.catch(failInternal));
        }),
      );
  }),
).pipe(Layer.provide(bodyLimit));
