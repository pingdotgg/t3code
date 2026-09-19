import type { EnvironmentSpeechModel, EnvironmentSpeechStatus } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { SPEECH_STREAM_MAX_CHUNK_BYTES } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { loadNativeSpeechModel } from "./native.ts";
import {
  DEFAULT_SPEECH_MODEL_ID,
  downloadSpeechModel,
  getSpeechModel,
  isSpeechModelReady,
  removeSpeechModel,
  SPEECH_MODELS,
} from "./model.ts";
import { applySpeechCustomWords, normalizeSpeechCustomWords } from "./customWords.ts";
import { removeSpeechFillerWords } from "./fillerWords.ts";

const SAMPLE_RATE = 16_000;
const MAX_SPEECH_DURATION_SECONDS = 5 * 60;
export const MAX_SPEECH_BYTES =
  SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT * MAX_SPEECH_DURATION_SECONDS;
const MIN_CAPTURE_RMS = 0.0005;

export class SpeechInvalidAudioError extends Schema.TaggedError<SpeechInvalidAudioError>()(
  "SpeechInvalidAudioError",
  { byteLength: Schema.Number, message: Schema.String },
) {}

export function decodeSpeechPcm(pcmBytes: Uint8Array, preserveSilence = false): Float32Array {
  if (
    pcmBytes.byteLength === 0 ||
    pcmBytes.byteLength > MAX_SPEECH_BYTES ||
    pcmBytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
  ) {
    throw new SpeechInvalidAudioError({
      byteLength: pcmBytes.byteLength,
      message: "audio must contain at most five minutes of 16 kHz mono Float32 PCM",
    });
  }
  // WebSocket frames can be pooled Node Buffers whose backing storage is larger
  // than the frame. Copy the view so only the received bytes are decoded.
  const pcm = new Float32Array(Uint8Array.from(pcmBytes).buffer);
  let energy = 0;
  for (const sample of pcm) {
    if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
      throw new SpeechInvalidAudioError({
        byteLength: pcmBytes.byteLength,
        message: "audio contains an invalid PCM sample",
      });
    }
    energy += sample * sample;
  }
  return !preserveSilence && Math.sqrt(energy / pcm.length) < MIN_CAPTURE_RMS
    ? new Float32Array()
    : pcm;
}

export class SpeechOperationError extends Schema.TaggedError<SpeechOperationError>()(
  "SpeechOperationError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment speech ${this.operation} failed.`;
  }
}

export class SpeechUnsupportedPlatformError extends Schema.TaggedError<SpeechUnsupportedPlatformError>()(
  "SpeechUnsupportedPlatformError",
  { platform: Schema.String, architecture: Schema.String },
) {}

export class SpeechBusyError extends Schema.TaggedError<SpeechBusyError>()("SpeechBusyError", {
  operation: Schema.String,
}) {}

export class SpeechModelNotFoundError extends Schema.TaggedError<SpeechModelNotFoundError>()(
  "SpeechModelNotFoundError",
  { modelId: Schema.String },
) {}

export class SpeechDownloadCancelledError extends Schema.TaggedError<SpeechDownloadCancelledError>()(
  "SpeechDownloadCancelledError",
  { modelId: Schema.String },
) {}

type SpeechError =
  | SpeechOperationError
  | SpeechInvalidAudioError
  | SpeechUnsupportedPlatformError
  | SpeechModelNotFoundError
  | SpeechDownloadCancelledError
  | SpeechBusyError;

const isSpeechError = Schema.is(
  Schema.Union([
    SpeechInvalidAudioError,
    SpeechUnsupportedPlatformError,
    SpeechBusyError,
    SpeechModelNotFoundError,
    SpeechDownloadCancelledError,
    SpeechOperationError,
  ]),
);

type LoadedModel = Awaited<ReturnType<typeof loadNativeSpeechModel>>;

export type SpeechStream = {
  readonly feed: (
    pcm: Uint8Array,
  ) => Effect.Effect<Awaited<ReturnType<LoadedModel["feed"]>>, SpeechError>;
  readonly finish: Effect.Effect<string, SpeechError>;
};

export class SpeechService extends Context.Service<
  SpeechService,
  {
    readonly status: Effect.Effect<EnvironmentSpeechStatus, SpeechOperationError>;
    readonly models: Effect.Effect<
      { readonly models: ReadonlyArray<EnvironmentSpeechModel> },
      SpeechOperationError
    >;
    readonly downloadModel: (
      modelId: string,
    ) => Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
    readonly selectModel: (modelId: string) => Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
    readonly cancelDownload: (
      modelId: string,
    ) => Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
    readonly transcribe: (pcmBytes: Uint8Array) => Effect.Effect<string, SpeechError>;
    readonly updateCustomWords: (
      words: readonly string[],
    ) => Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
    readonly updateFillerWordRemoval: (
      enabled: boolean,
    ) => Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
    readonly startStream: Effect.Effect<SpeechStream, SpeechError, Scope.Scope>;
    readonly removeModel: (modelId: string) => Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
  }
>()("t3/speech/SpeechService") {}

function supported(platform: string, architecture: string): string | null {
  const tuple = `${platform}-${architecture}`;
  return new Set(["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64", "linux-arm64"]).has(tuple)
    ? null
    : `voice transcription is not available on ${tuple}`;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const unsupportedReason = supported(platform, architecture);
  const modelDirectory = path.join(config.stateDir, "speech", "models");
  let model: LoadedModel | undefined;
  let loadedModelId: string | undefined;
  let loading: Promise<LoadedModel> | undefined;
  let downloading:
    | { modelId: string; downloaded: number; verifying: boolean; controller: AbortController }
    | undefined;
  let activeTranscriptions = 0;
  let activeOperation: Promise<unknown> | undefined;
  let closing = false;
  const lifetime = new AbortController();

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closing = true;
      lifetime.abort();
      await model?.dispose();
      model = undefined;
      loadedModelId = undefined;
      loading = undefined;
    }),
  );

  type SettingsSnapshot = Effect.Success<
    ServerSettings.ServerSettingsService["Service"]["getSettings"]
  >;

  const selectedModel = (settings: SettingsSnapshot) => {
    return getSpeechModel(settings.speechModelId) ?? getSpeechModel(DEFAULT_SPEECH_MODEL_ID)!;
  };

  const download = async (modelId: string, signal = lifetime.signal) => {
    const definition = getSpeechModel(modelId);
    if (!definition) throw new SpeechModelNotFoundError({ modelId });
    if (downloading && downloading.modelId !== modelId)
      throw new SpeechBusyError({ operation: "model download" });
    const controller = new AbortController();
    downloading = { modelId, downloaded: 0, verifying: false, controller };
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const modelPath = await downloadSpeechModel(
        modelDirectory,
        definition,
        controller.signal,
        (downloaded) => {
          if (downloading?.modelId === modelId) downloading.downloaded = downloaded;
        },
      );
      if (downloading?.modelId === modelId) downloading.verifying = true;
      return modelPath;
    } catch (error) {
      if (controller.signal.aborted) throw new SpeechDownloadCancelledError({ modelId });
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      if (downloading?.modelId === modelId) downloading = undefined;
    }
  };

  const loadModel = async (
    definition: ReturnType<typeof selectedModel>,
    signal = lifetime.signal,
    backend: "auto" | "cpu" = "auto",
  ) => {
    if (
      model &&
      loadedModelId === definition.id &&
      (backend === "auto" || model.backend.toLowerCase() === "cpu")
    )
      return model;
    if (model) {
      await model.dispose();
      model = undefined;
      loadedModelId = undefined;
    }
    const pending =
      loading ??
      download(definition.id, signal)
        .then(async (modelPath) => {
          const loaded = await loadNativeSpeechModel(modelPath, signal, undefined, backend);
          if (closing) {
            await loaded.dispose();
            throw new SpeechBusyError({ operation: "model preparation" });
          }
          model = loaded;
          loadedModelId = definition.id;
          loading = undefined;
          return loaded;
        })
        .catch((error) => {
          loading = undefined;
          throw error;
        });
    loading = pending;
    return pending;
  };

  const attempt = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new SpeechOperationError({ operation, cause }),
    });

  const readSettings = (operation: string) =>
    serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new SpeechOperationError({ operation, cause })),
    );

  const writeSettings = (
    operation: string,
    patch: Parameters<ServerSettings.ServerSettingsService["Service"]["updateSettings"]>[0],
  ) =>
    serverSettings
      .updateSettings(patch)
      .pipe(Effect.mapError((cause) => new SpeechOperationError({ operation, cause })));

  const exclusive = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        if (closing || activeOperation) throw new SpeechBusyError({ operation });
        const pending = run();
        activeOperation = pending;
        try {
          return await pending;
        } finally {
          activeOperation = undefined;
        }
      },
      catch: (cause): SpeechError =>
        isSpeechError(cause) ? cause : new SpeechOperationError({ operation, cause }),
    });

  const currentStatus = async (settings: SettingsSnapshot): Promise<EnvironmentSpeechStatus> => {
    if (unsupportedReason) return { supported: false, reason: unsupportedReason };
    const definition = selectedModel(settings);
    return {
      supported: true,
      state:
        activeTranscriptions > 0
          ? "transcribing"
          : (await isSpeechModelReady(modelDirectory, definition))
            ? "ready"
            : "missing-model",
      modelId: definition.id,
      model: definition.name,
      size: definition.size,
      supportsStreaming: definition.supportsStreaming,
      customWords: normalizeSpeechCustomWords(settings.speechCustomWords),
      removeFillerWords: settings.speechRemoveFillerWords,
    };
  };

  const listModels = async (settings: SettingsSnapshot) => {
    const selected = selectedModel(settings);
    return {
      models: await Promise.all(
        SPEECH_MODELS.map(async (definition) => {
          const ready = await isSpeechModelReady(modelDirectory, definition);
          const operation = downloading?.modelId === definition.id ? downloading : undefined;
          return {
            id: definition.id,
            name: definition.name,
            description: definition.description,
            size: definition.size,
            languages: definition.languages,
            accuracy: definition.accuracy,
            speed: definition.speed,
            recommended: definition.recommended,
            supportsStreaming: definition.supportsStreaming,
            active: selected.id === definition.id,
            state: operation
              ? operation.verifying
                ? ("verifying" as const)
                : ("downloading" as const)
              : ready
                ? ("installed" as const)
                : ("downloadable" as const),
            ...(operation ? { downloaded: operation.downloaded } : {}),
          };
        }),
      ),
    };
  };

  const freshStatus = (operation: string) =>
    readSettings(operation).pipe(
      Effect.flatMap((settings) => attempt(operation, () => currentStatus(settings))),
    );

  const statusEffect = freshStatus("status");
  const modelsEffect = readSettings("model listing").pipe(
    Effect.flatMap((settings) => attempt("model listing", () => listModels(settings))),
  );

  return SpeechService.of({
    startStream: Effect.gen(function* () {
      const operation = "streaming transcription";
      if (closing || activeOperation) return yield* new SpeechBusyError({ operation });
      if (unsupportedReason)
        return yield* new SpeechUnsupportedPlatformError({ platform, architecture });
      const released = Promise.withResolvers<void>();
      activeOperation = released.promise;
      activeTranscriptions += 1;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, lifetime.signal]);
      let finished = false;
      let loaded: LoadedModel | undefined;
      const settings = yield* readSettings("custom words loading");
      const customWords = normalizeSpeechCustomWords(settings.speechCustomWords);
      const removeFillerWords = settings.speechRemoveFillerWords;
      const definition =
        getSpeechModel(settings.speechModelId) ?? getSpeechModel(DEFAULT_SPEECH_MODEL_ID)!;
      const fillerWordLanguage =
        definition.languages.length === 1 ? definition.languages[0] : undefined;
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          // Cancellation can arrive inside native compute. Kill the owned process before releasing the lease.
          if (!finished) {
            controller.abort();
            await loading?.catch(() => undefined);
            await (loaded ?? model)?.dispose();
            model = undefined;
            loadedModelId = undefined;
          }
          activeTranscriptions -= 1;
          if (activeOperation === released.promise) activeOperation = undefined;
          released.resolve();
        }),
      );
      const preparation = yield* attempt(operation, async () => {
        const startedAt = performance.now();
        const prepared = await loadModel(definition, signal);
        if (!prepared.supportsStreaming)
          throw new Error("The selected model does not support streaming.");
        await prepared.begin();
        return { prepared, durationMs: performance.now() - startedAt };
      });
      let streamModel = preparation.prepared;
      loaded = streamModel;
      yield* Effect.logInfo("Speech stream prepared", {
        backend: streamModel.backend,
        durationMs: Math.round(preparation.durationMs),
      });
      let byteLength = 0;
      const received: Float32Array[] = [];
      let usedCpuFallback = false;
      let busy = false;
      const run = <A>(work: () => Promise<A>) =>
        attempt(operation, async () => {
          if (busy || finished || signal.aborted) throw new Error("Speech stream is not ready.");
          busy = true;
          try {
            return await work();
          } finally {
            busy = false;
          }
        });
      return {
        feed: (bytes: Uint8Array) =>
          run(async () => {
            if (
              bytes.byteLength > SPEECH_STREAM_MAX_CHUNK_BYTES ||
              byteLength + bytes.byteLength > MAX_SPEECH_BYTES
            )
              throw new SpeechInvalidAudioError({
                byteLength: bytes.byteLength,
                message: "Speech stream audio limit exceeded.",
              });
            const pcm = decodeSpeechPcm(bytes, true);
            byteLength += bytes.byteLength;
            received.push(pcm);
            try {
              const update = await streamModel.feed(pcm);
              return {
                ...update,
                text: update.text
                  ? {
                      committed: applySpeechCustomWords(update.text.committed, customWords),
                      tentative: applySpeechCustomWords(update.text.tentative, customWords),
                    }
                  : null,
              };
            } catch (cause) {
              if (usedCpuFallback || streamModel.backend.toLowerCase() === "cpu") throw cause;
              usedCpuFallback = true;
              await streamModel.dispose();
              if (model === streamModel) {
                model = undefined;
                loadedModelId = undefined;
                loading = undefined;
              }
              streamModel = await loadModel(definition, signal, "cpu");
              loaded = streamModel;
              await streamModel.begin();
              let update: Awaited<ReturnType<LoadedModel["feed"]>> | undefined;
              for (const chunk of received) update = await streamModel.feed(chunk);
              if (!update) throw cause;
              return {
                ...update,
                text: update.text
                  ? {
                      committed: applySpeechCustomWords(update.text.committed, customWords),
                      tentative: applySpeechCustomWords(update.text.tentative, customWords),
                    }
                  : null,
              };
            }
          }),
        finish: run(async () => {
          const startedAt = performance.now();
          const corrected = applySpeechCustomWords(await streamModel.finish(), customWords);
          const text = removeFillerWords
            ? removeSpeechFillerWords(corrected, fillerWordLanguage)
            : corrected;
          finished = true;
          return { text: text.trim(), durationMs: performance.now() - startedAt };
        }).pipe(
          Effect.tap(({ durationMs }) =>
            Effect.logInfo("Speech stream finalized", {
              backend: streamModel.backend,
              durationMs: Math.round(durationMs),
            }),
          ),
          Effect.map(({ text }) => text),
        ),
      };
    }),
    status: statusEffect,
    models: modelsEffect,
    downloadModel: (modelId) =>
      exclusive("model download", async () => {
        if (unsupportedReason) throw new SpeechUnsupportedPlatformError({ platform, architecture });
        await download(modelId);
      }).pipe(Effect.andThen(freshStatus("model download"))),
    selectModel: (modelId) =>
      exclusive("model selection", async () => {
        if (!getSpeechModel(modelId)) throw new SpeechModelNotFoundError({ modelId });
        await model?.dispose();
        model = undefined;
        loadedModelId = undefined;
        loading = undefined;
      }).pipe(
        Effect.andThen(writeSettings("model selection", { speechModelId: modelId })),
        Effect.andThen(freshStatus("model selection")),
      ),
    cancelDownload: (modelId) =>
      Effect.sync(() => {
        if (downloading?.modelId === modelId) downloading.controller.abort();
      }).pipe(Effect.andThen(freshStatus("model download cancellation"))),
    updateCustomWords: (words) => {
      const customWords = normalizeSpeechCustomWords(words);
      return exclusive("custom words update", async () => {}).pipe(
        Effect.andThen(writeSettings("custom words update", { speechCustomWords: customWords })),
        Effect.andThen(freshStatus("custom words update")),
      );
    },
    updateFillerWordRemoval: (enabled) =>
      exclusive("filler word removal update", async () => {}).pipe(
        Effect.andThen(
          writeSettings("filler word removal update", { speechRemoveFillerWords: enabled }),
        ),
        Effect.andThen(freshStatus("filler word removal update")),
      ),
    transcribe: (pcmBytes) =>
      readSettings("transcription").pipe(
        Effect.flatMap((settings) =>
          exclusive("transcription", async () => {
            if (unsupportedReason)
              throw new SpeechUnsupportedPlatformError({ platform, architecture });
            const pcm = decodeSpeechPcm(pcmBytes);
            if (pcm.length === 0)
              return { text: "", backend: "none", prepareDurationMs: 0, inferenceDurationMs: 0 };
            activeTranscriptions += 1;
            try {
              const definition = selectedModel(settings);
              const prepareStartedAt = performance.now();
              const loaded = await loadModel(definition).catch((cause) => {
                throw new SpeechOperationError({ operation: "model preparation", cause });
              });
              const prepareDurationMs = performance.now() - prepareStartedAt;
              const inferenceStartedAt = performance.now();
              let inferenceModel = loaded;
              const customWords = normalizeSpeechCustomWords(settings.speechCustomWords);
              const removeFillerWords = settings.speechRemoveFillerWords;
              const fillerWordLanguage =
                definition.languages.length === 1 ? definition.languages[0] : undefined;
              const options = {
                timestamps: "none" as const,
                ...(customWords.length > 0 && loaded.supportsInitialPrompt
                  ? {
                      family: {
                        kind: "whisper" as const,
                        initialPrompt: customWords.join(", "),
                      },
                    }
                  : {}),
              };
              let result: Awaited<ReturnType<LoadedModel["transcribe"]>>;
              try {
                result = await inferenceModel.transcribe(pcm, options);
              } catch (cause) {
                if (model === inferenceModel) {
                  model = undefined;
                  loadedModelId = undefined;
                  loading = undefined;
                }
                if (inferenceModel.backend.toLowerCase() === "cpu")
                  throw new SpeechOperationError({ operation: "inference", cause });
                await inferenceModel.dispose();
                inferenceModel = await loadModel(definition, lifetime.signal, "cpu");
                result = await inferenceModel.transcribe(pcm, options).catch((fallbackCause) => {
                  if (model === inferenceModel) {
                    model = undefined;
                    loadedModelId = undefined;
                    loading = undefined;
                  }
                  throw new SpeechOperationError({ operation: "inference", cause: fallbackCause });
                });
              }
              const corrected = loaded.supportsInitialPrompt
                ? result.text
                : applySpeechCustomWords(result.text, customWords);
              return {
                text: (removeFillerWords
                  ? removeSpeechFillerWords(corrected, fillerWordLanguage)
                  : corrected
                ).trim(),
                backend: inferenceModel.backend,
                prepareDurationMs,
                inferenceDurationMs: performance.now() - inferenceStartedAt,
              };
            } finally {
              activeTranscriptions -= 1;
            }
          }),
        ),
        Effect.tap(({ backend, prepareDurationMs, inferenceDurationMs }) =>
          Effect.logInfo("Speech transcription completed", {
            backend,
            prepareDurationMs: Math.round(prepareDurationMs),
            inferenceDurationMs: Math.round(inferenceDurationMs),
          }),
        ),
        Effect.map(({ text }) => text),
      ),
    removeModel: (modelId) =>
      readSettings("model removal").pipe(
        Effect.flatMap((settings) =>
          exclusive("model removal", async () => {
            const definition = getSpeechModel(modelId);
            if (!definition) throw new SpeechModelNotFoundError({ modelId });
            const selected = selectedModel(settings);
            await loading?.catch(() => undefined);
            if (loadedModelId === modelId) {
              await model?.dispose();
              model = undefined;
              loadedModelId = undefined;
              loading = undefined;
            }
            await removeSpeechModel(modelDirectory, definition);
            if (selected.id !== modelId) return undefined;
            const candidates = await Promise.all(
              SPEECH_MODELS.filter((candidate) => candidate.id !== modelId).map(
                async (candidate) => ({
                  candidate,
                  ready: await isSpeechModelReady(modelDirectory, candidate),
                }),
              ),
            );
            return candidates.find(({ ready }) => ready)?.candidate.id;
          }).pipe(
            Effect.flatMap((replacementId) =>
              replacementId
                ? writeSettings("model removal", { speechModelId: replacementId }).pipe(
                    Effect.andThen(freshStatus("model removal")),
                  )
                : freshStatus("model removal"),
            ),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(SpeechService, make);
