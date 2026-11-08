import { decodeSpeechPcmRequest } from "@t3tools/shared/speech";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  EnvironmentHttpApi,
  EnvironmentVoiceBodyLimit,
  SPEECH_MAX_OPTIONS_BYTES,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SpeechPostProcessing from "./postProcessing.ts";
import * as CloudSpeech from "./CloudSpeech.ts";
import * as SpeechCleanupApi from "./SpeechCleanupApi.ts";
import * as SpeechService from "./SpeechService.ts";

const MAX_TRANSCRIBE_BODY_BYTES = SpeechService.MAX_SPEECH_BYTES + SPEECH_MAX_OPTIONS_BYTES + 4;
const parseAudio = Option.liftThrowable(decodeSpeechPcmRequest);

const bodyLimit = Layer.succeed(EnvironmentVoiceBodyLimit, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (Number(request.headers["content-length"]) > MAX_TRANSCRIBE_BODY_BYTES)
      return yield* failEnvironmentInvalidRequest("invalid_audio");
    return yield* effect.pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        ByteSize.bytes(MAX_TRANSCRIBE_BODY_BYTES),
      ),
    );
  }),
);

const mapSpeechError = <A, R>(effect: Effect.Effect<A, SpeechService.SpeechError, R>) =>
  effect.pipe(
    Effect.catchTags({
      SpeechInvalidAudioError: () => failEnvironmentInvalidRequest("invalid_audio"),
      SpeechUnsupportedPlatformError: () => failEnvironmentInvalidRequest("speech_unavailable"),
      SpeechBusyError: () => failEnvironmentInvalidRequest("speech_busy"),
      SpeechDownloadCancelledError: () => failEnvironmentInvalidRequest("speech_busy"),
      SpeechModelNotFoundError: () => failEnvironmentInvalidRequest("invalid_command"),
      SpeechOperationError: (error) => failEnvironmentInternal("internal_error", error),
    }),
  );

export const speechHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const speech = yield* SpeechService.SpeechService;
    const cloud = yield* CloudSpeech.CloudSpeech;
    const postProcessing = yield* SpeechPostProcessing.SpeechPostProcessing;
    const cleanup = yield* SpeechCleanupApi.SpeechCleanupApi;
    const guard = Effect.fnUntraced(function* (
      endpoint: string,
      scope: AuthEnvironmentScope = AuthOrchestrationOperateScope,
    ) {
      yield* annotateEnvironmentRequest(endpoint);
      yield* requireEnvironmentScope(scope);
    });
    return handlers
      .handle(
        "cleanupModels",
        Effect.fn("environment.voice.cleanupModels")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* cleanup
            .models(args.params.provider)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }),
      )
      .handle(
        "cloudKeys",
        Effect.fn("environment.voice.cloudKeys")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* cloud.configured.pipe(
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
        }),
      )
      .handle(
        "setCloudKey",
        Effect.fn("environment.voice.setCloudKey")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          yield* cloud
            .setKey(args.params.provider, args.payload.key)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }),
      )
      .handle(
        "cloudModels",
        Effect.fn("environment.voice.cloudModels")(function* (args) {
          yield* guard(args.endpoint.name);
          return { models: yield* cloud.models };
        }),
      )
      .handle(
        "transcribeCloud",
        Effect.fn("environment.voice.transcribeCloud")(function* (args) {
          yield* guard(args.endpoint.name);
          const decoded = parseAudio(args.payload);
          if (Option.isNone(decoded)) return yield* failEnvironmentInvalidRequest("invalid_audio");
          const text = yield* cloud
            .transcribe(
              args.params.provider,
              decoded.value.pcm,
              decoded.value.options,
              args.query.model,
            )
            .pipe(
              Effect.catchTags({
                ServerSettingsError: (error) => failEnvironmentInternal("internal_error", error),
                SpeechInvalidAudioError: () => failEnvironmentInvalidRequest("invalid_audio"),
              }),
            );
          return { text };
        }),
      )
      .handle(
        "status",
        Effect.fn("environment.voice.status")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* speech.status.pipe(mapSpeechError);
        }),
      )
      .handle(
        "prepareModel",
        Effect.fn("environment.voice.prepareModel")(function* (args) {
          yield* guard(args.endpoint.name);
          yield* speech.prepareModel.pipe(mapSpeechError);
        }),
      )
      .handle(
        "models",
        Effect.fn("environment.voice.models")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* speech.models(args.query.benchmarks === "1").pipe(mapSpeechError);
        }),
      )
      .handle(
        "downloadModel",
        Effect.fn("environment.voice.downloadModel")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.downloadModel(args.payload.modelId).pipe(mapSpeechError);
        }),
      )
      .handle(
        "selectModel",
        Effect.fn("environment.voice.selectModel")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.selectModel(args.payload.modelId).pipe(mapSpeechError);
        }),
      )
      .handle(
        "cancelModelDownload",
        Effect.fn("environment.voice.cancelModelDownload")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.cancelDownload(args.payload.modelId).pipe(mapSpeechError);
        }),
      )
      .handle(
        "removeModel",
        Effect.fn("environment.voice.removeModel")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.removeModel(args.payload.modelId).pipe(mapSpeechError);
        }),
      )
      .handle(
        "updateAcceleration",
        Effect.fn("environment.voice.updateAcceleration")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.updateAcceleration(args.payload.acceleration).pipe(mapSpeechError);
        }),
      )
      .handle(
        "updateModelUnloadTimeout",
        Effect.fn("environment.voice.updateModelUnloadTimeout")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* speech.updateModelUnloadTimeout(args.payload.timeout).pipe(mapSpeechError);
        }),
      )
      .handle(
        "transcribe",
        Effect.fn("environment.voice.transcribe")(function* (args) {
          yield* guard(args.endpoint.name);
          const decoded = parseAudio(args.payload);
          if (Option.isNone(decoded)) return yield* failEnvironmentInvalidRequest("invalid_audio");
          const text = yield* speech
            .transcribe(decoded.value.pcm, decoded.value.options)
            .pipe(mapSpeechError);
          return { text };
        }),
      )
      .handle(
        "postProcess",
        Effect.fn("environment.voice.postProcess")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* postProcessing
            .process(args.payload)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        }),
      );
  }),
).pipe(Layer.provide(bodyLimit), Layer.provide(SpeechPostProcessing.layer));
