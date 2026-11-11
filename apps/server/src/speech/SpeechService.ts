import {
  SPEECH_STREAM_MAX_CHUNK_BYTES,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechStatus,
  type SpeechAcceleration,
  type SpeechModelUnloadTimeout,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { makeSpeechTextCorrector, normalizeSpeechCustomWords } from "./customWords.ts";
import { removeSpeechFillerWords } from "./fillerWords.ts";
import {
  DEFAULT_SPEECH_MODEL_ID,
  effectiveSpeechLanguage,
  getSpeechModel,
  SPEECH_MODELS,
  type SpeechModel,
} from "./model.ts";
import { listNativeSpeechGpuDevices, loadNativeSpeechModel } from "./native.ts";
import { nativeSpeechLanguage } from "./nativeLanguage.ts";
import { SILERO_VAD } from "./silero.ts";
import { isSpeechPlatformSupported } from "./platform.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";

const SAMPLE_RATE = 16_000;
const MAX_SPEECH_DURATION_SECONDS = 5 * 60;
export const MAX_SPEECH_BYTES =
  SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT * MAX_SPEECH_DURATION_SECONDS;

export class SpeechInvalidAudioError extends Schema.TaggedError<SpeechInvalidAudioError>()(
  "SpeechInvalidAudioError",
  { byteLength: Schema.Number, message: Schema.String },
) {}

export function decodeSpeechPcm(pcmBytes: Uint8Array): Float32Array {
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
  for (const sample of pcm) {
    if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
      throw new SpeechInvalidAudioError({
        byteLength: pcmBytes.byteLength,
        message: "audio contains an invalid PCM sample",
      });
    }
  }
  return pcm;
}

export class SpeechOperationError extends Schema.TaggedError<SpeechOperationError>()(
  "SpeechOperationError",
  { operation: Schema.String, cause: Schema.Defect() },
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

export type SpeechError =
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
type SpeechModels = { readonly models: ReadonlyArray<EnvironmentSpeechModel> };

export type SpeechStream = {
  readonly feed: (
    pcm: Uint8Array,
  ) => Effect.Effect<Awaited<ReturnType<LoadedModel["feed"]>>, SpeechError>;
  readonly finish: Effect.Effect<string, SpeechError>;
};

export class SpeechService extends Context.Service<
  SpeechService,
  {
    readonly status: Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
    readonly models: (includeBenchmarks: boolean) => Effect.Effect<SpeechModels, SpeechError>;
    readonly downloadModel: (modelId: string) => Effect.Effect<SpeechModels, SpeechError>;
    readonly selectModel: (modelId: string) => Effect.Effect<SpeechModels, SpeechError>;
    readonly cancelDownload: (modelId: string) => Effect.Effect<SpeechModels, SpeechError>;
    readonly removeModel: (modelId: string) => Effect.Effect<SpeechModels, SpeechError>;
    /** Uses catalog model files already on this machine, from a file or folder path. */
    readonly linkModels: (source: string) => Effect.Effect<SpeechModels, SpeechError>;
    readonly prepareModel: Effect.Effect<void, SpeechError>;
    readonly transcribe: (
      pcmBytes: Uint8Array,
      options: SpeechTranscriptionOptions,
    ) => Effect.Effect<string, SpeechError>;
    readonly startStream: (
      options: SpeechTranscriptionOptions,
    ) => Effect.Effect<SpeechStream, SpeechError, Scope.Scope>;
    readonly updateAcceleration: (
      acceleration: SpeechAcceleration,
    ) => Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
    readonly updateModelUnloadTimeout: (
      timeout: SpeechModelUnloadTimeout,
    ) => Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
  }
>()("t3/speech/SpeechService") {}

const UNLOAD_MILLISECONDS: Record<Exclude<SpeechModelUnloadTimeout, "never">, number> = {
  immediately: 0,
  min_2: 2 * 60_000,
  min_5: 5 * 60_000,
  min_10: 10 * 60_000,
  min_15: 15 * 60_000,
  hour_1: 60 * 60_000,
};

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const store = yield* SpeechModelStore.SpeechModelStore;
  const scope = yield* Effect.scope;
  const clock = yield* Clock.Clock;
  const now = () => clock.currentTimeMillisUnsafe();
  const libc = platform === "linux" ? yield* HostProcess.LinuxLibc : undefined;
  const unsupportedReason = isSpeechPlatformSupported(platform, architecture, libc)
    ? null
    : `voice transcription is not available on ${platform}-${architecture}`;

  let model: LoadedModel | undefined;
  let loadedModelId: string | undefined;
  let loadedAcceleration: string | undefined;
  let autoCpuModel: string | undefined;
  let loading: Promise<LoadedModel> | undefined;
  const discoverGpuDevices = yield* Effect.tryPromise({
    try: () => listNativeSpeechGpuDevices(),
    catch: (cause) => new SpeechOperationError({ operation: "discover GPU devices", cause }),
  }).pipe(Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? Duration.infinity : "1 minute")));
  let downloading:
    | {
        modelId: string;
        downloaded: number;
        verifying: boolean;
        fiber: Deferred.Deferred<Fiber.Fiber<string, SpeechError>>;
      }
    | undefined;
  let activeTranscriptions = 0;
  // One native request at a time; the slot is a promise so unload waits for it.
  let activeOperation: Promise<unknown> | undefined;
  const operationBusy = () => Boolean(activeOperation || downloading);
  let closing = false;
  // @effect-diagnostics-next-line abortControllerInEffect:off - Cached native workers must also stop on service shutdown.
  const lifetime = new AbortController();
  let unloadTimeout: SpeechModelUnloadTimeout = "min_15";

  // Deadlines are absolute: the consumer fiber registers its sleep a few scheduler
  // hops after the request, so a relative delay would drift.
  const unloadRequests = yield* Queue.sliding<{ deadline: number } | null>(1);
  const clearUnloadTimer = () => Queue.offerUnsafe(unloadRequests, null);
  const scheduleUnload = (minimumDelayMs = 0) => {
    clearUnloadTimer();
    if (!model || closing || unloadTimeout === "never") return;
    Queue.offerUnsafe(unloadRequests, {
      deadline: now() + Math.max(minimumDelayMs, UNLOAD_MILLISECONDS[unloadTimeout]),
    });
  };

  const forgetModel = (target: LoadedModel) => {
    if (model !== target) return;
    model = undefined;
    loadedModelId = undefined;
    loadedAcceleration = undefined;
  };
  const disposeModel = async () => {
    const target = model;
    if (!target) return;
    forgetModel(target);
    await target.dispose();
  };
  // Stops the isolated process without waiting for native work to settle.
  const dropModel = (target: LoadedModel) => {
    forgetModel(target);
    void Promise.resolve()
      .then(() => target.dispose())
      .catch(() => undefined);
  };

  // Auto placement may land on a GPU the native engine cannot actually run; one retry on
  // this host's CPU recovers it. A GPU the person chose, and CPU itself, report the error.
  const canRetryOnCpu = (acceleration: SpeechAcceleration, loaded: LoadedModel) =>
    acceleration === "auto" && loaded.backend.toLowerCase() !== "cpu";

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closing = true;
      clearUnloadTimer();
      lifetime.abort();
      await disposeModel();
    }),
  );

  yield* Stream.fromQueue(unloadRequests).pipe(
    Stream.switchMap((request) =>
      request === null
        ? Stream.empty
        : Stream.fromEffect(
            Effect.gen(function* () {
              yield* Effect.sleep(Math.max(0, request.deadline - now()));
              if (closing) return;
              if (operationBusy() || activeTranscriptions || loading) {
                scheduleUnload(1000);
                return;
              }
              yield* Effect.promise(() => disposeModel().catch(() => undefined)).pipe(
                Effect.uninterruptible,
              );
            }),
          ),
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );

  type SettingsSnapshot = Effect.Success<
    ServerSettings.ServerSettingsService["Service"]["getSettings"]
  >;

  const selectedModel = (settings: SettingsSnapshot): SpeechModel =>
    getSpeechModel(settings.speechModelId) ?? getSpeechModel(DEFAULT_SPEECH_MODEL_ID)!;

  let silenceRetryAt = 0;
  const acquireSilenceModel = Effect.fn("SpeechService.acquireSilenceModel")(function* (
    purpose: "installation" | "recording",
  ) {
    if (purpose === "recording" && now() < silenceRetryAt) return undefined;
    const path = yield* store.download(SILERO_VAD).pipe(
      Effect.timeout(purpose === "recording" ? "15 seconds" : "2 minutes"),
      Effect.orElseSucceed(() => undefined),
    );
    if (path !== undefined) {
      silenceRetryAt = 0;
      return path;
    }
    silenceRetryAt = now() + 10 * 60_000;
    yield* Effect.logWarning("Silero unavailable; using raw audio with bounded ASR processing.");
  });

  // Publish the reservation before forking: a cached transfer can finish before forkIn returns.
  const downloadFiber = Effect.fn("SpeechService.downloadFiber")(function* (modelId: string) {
    const definition = getSpeechModel(modelId);
    if (!definition) return yield* new SpeechModelNotFoundError({ modelId });
    if (closing || activeOperation || (downloading && downloading.modelId !== modelId))
      return yield* new SpeechBusyError({ operation: "model download" });
    if (downloading) return yield* Deferred.await(downloading.fiber);
    const transfer = {
      modelId,
      downloaded: 0,
      verifying: false,
      fiber: Deferred.makeUnsafe<Fiber.Fiber<string, SpeechError>>(),
    };
    downloading = transfer;
    const fiber = yield* store
      .download(definition, {
        onProgress: (downloaded) => {
          transfer.downloaded = downloaded;
          transfer.verifying = false;
        },
        onVerificationStart: () => {
          transfer.verifying = true;
        },
      })
      .pipe(
        (modelDownload) =>
          Effect.all([modelDownload, acquireSilenceModel("installation")], { concurrency: 2 }),
        Effect.map(([modelPath]) => modelPath),
        Effect.mapError((cause) => speechError("model download", cause)),
        Effect.forkIn(scope),
      );
    fiber.addObserver(() => {
      if (downloading !== transfer) return;
      downloading = undefined;
      scheduleUnload();
    });
    yield* Deferred.succeed(transfer.fiber, fiber);
    return fiber;
  }, Effect.uninterruptible);

  const download = Effect.fn("SpeechService.download")(function* (modelId: string) {
    const exit = yield* Fiber.await(yield* downloadFiber(modelId));
    if (Exit.isSuccess(exit)) return exit.value;
    return yield* Cause.hasInterruptsOnly(exit.cause)
      ? new SpeechDownloadCancelledError({ modelId })
      : Effect.failCause(exit.cause);
  });

  const installedModelPath = (definition: SpeechModel) =>
    store.installedPath(definition).pipe(
      Effect.filterOrFail(
        (modelPath) => modelPath !== undefined,
        () => new SpeechModelNotFoundError({ modelId: definition.id }),
      ),
    );

  const loadModel = async (
    modelPath: string,
    definition: SpeechModel,
    signal = lifetime.signal,
    requestedAcceleration = "auto",
  ) => {
    const acceleration =
      requestedAcceleration === "auto" && autoCpuModel === definition.id
        ? "cpu"
        : requestedAcceleration;
    if (model && loadedModelId === definition.id && loadedAcceleration === acceleration) {
      scheduleUnload();
      return model;
    }
    if (loading) return loading;
    await disposeModel();
    signal.throwIfAborted();
    const pending = loadNativeSpeechModel(modelPath, signal, undefined, acceleration).then(
      async (loaded) => {
        if (closing || signal.aborted) {
          await loaded.dispose();
          signal.throwIfAborted();
          throw new SpeechBusyError({ operation: "model preparation" });
        }
        model = loaded;
        loadedModelId = definition.id;
        loadedAcceleration = acceleration;
        scheduleUnload();
        return loaded;
      },
    );
    const release = () => {
      if (loading === pending) loading = undefined;
    };
    loading = pending;
    signal.addEventListener("abort", release, { once: true });
    try {
      return await pending;
    } finally {
      signal.removeEventListener("abort", release);
      release();
    }
  };

  const speechError = (operation: string, cause: unknown): SpeechError =>
    isSpeechError(cause) ? cause : new SpeechOperationError({ operation, cause });

  const attempt = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => speechError(operation, cause) });

  // The busy slot is released by a finalizer, so interrupting the fiber frees it at
  // once instead of waiting for native work that may never settle.
  const exclusive = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend<A, E | SpeechBusyError, R>(() => {
        if (closing || operationBusy()) return Effect.fail(new SpeechBusyError({ operation }));
        const gate = Promise.withResolvers<void>();
        activeOperation = gate.promise;
        return restore(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (activeOperation === gate.promise) activeOperation = undefined;
              scheduleUnload(
                operation === "model preparation" ? MAX_SPEECH_DURATION_SECONDS * 1000 : 0,
              );
              gate.resolve();
            }),
          ),
        );
      }),
    );

  const readSettings = (operation: string) =>
    serverSettings.getSettings.pipe(
      Effect.tap((settings) =>
        Effect.sync(() => {
          if (settings.speechModelId !== autoCpuModel || settings.speechAcceleration !== "auto")
            autoCpuModel = undefined;
          if (unloadTimeout !== settings.speechModelUnloadTimeout) {
            unloadTimeout = settings.speechModelUnloadTimeout;
            scheduleUnload();
          }
        }),
      ),
      Effect.mapError((cause) => new SpeechOperationError({ operation, cause })),
    );

  const writeSettings = (
    operation: string,
    patch: Parameters<ServerSettings.ServerSettingsService["Service"]["updateSettings"]>[0],
  ) =>
    serverSettings
      .updateSettings(patch)
      .pipe(Effect.mapError((cause) => new SpeechOperationError({ operation, cause })));

  const currentStatus = Effect.fn("SpeechService.currentStatus")(function* (
    settings: SettingsSnapshot,
  ): Effect.fn.Return<EnvironmentSpeechStatus> {
    if (unsupportedReason) return { supported: false, reason: unsupportedReason };
    const definition = selectedModel(settings);
    const ready = yield* store.isReady(definition);
    const gpuDevices = yield* discoverGpuDevices.pipe(Effect.orElseSucceed(() => []));
    const autoUsesCpu =
      gpuDevices.length === 0 ||
      autoCpuModel === definition.id ||
      (loadedModelId === definition.id &&
        loadedAcceleration === "auto" &&
        model?.backend.toLowerCase() === "cpu");
    return {
      supported: true,
      state: activeTranscriptions > 0 ? "transcribing" : ready ? "ready" : "missing-model",
      modelId: definition.id,
      model: definition.name,
      size: definition.size,
      supportsStreaming: definition.supportsStreaming,
      supportsBufferedStreaming: true,
      supportsModelLinking: true,
      supportsTranslation: definition.supportsTranslation,
      languages: definition.languages,
      supportsLanguageDetection: definition.supportsLanguageDetection,
      acceleration: settings.speechAcceleration,
      benchmarkTier:
        settings.speechAcceleration === "cpu" ||
        (settings.speechAcceleration === "auto" && autoUsesCpu)
          ? "cpu"
          : "accelerated",
      modelUnloadTimeout: settings.speechModelUnloadTimeout,
      gpuDevices,
    };
  });

  const listModels = Effect.fn("SpeechService.listModels")(function* (
    settings: SettingsSnapshot,
    includeBenchmarks: boolean,
  ): Effect.fn.Return<SpeechModels> {
    const selected = selectedModel(settings);
    const models = yield* Effect.forEach(
      SPEECH_MODELS,
      (definition) =>
        Effect.all([store.isReady(definition), store.linkedFrom(definition)]).pipe(
          Effect.map(([ready, linkedFrom]): EnvironmentSpeechModel => {
            const operation = downloading?.modelId === definition.id ? downloading : undefined;
            return {
              id: definition.id,
              name: definition.name,
              description: definition.description,
              size: definition.size,
              languages: definition.languages,
              accuracy: definition.accuracy,
              speed: definition.speed,
              ...(includeBenchmarks ? { benchmark: definition.benchmark } : {}),
              recommended: definition.recommended,
              supportsStreaming: definition.supportsStreaming,
              supportsLanguageDetection: definition.supportsLanguageDetection,
              supportsTranslation: definition.supportsTranslation,
              active: ready && selected.id === definition.id,
              state: operation
                ? operation.verifying
                  ? "verifying"
                  : "downloading"
                : ready
                  ? "installed"
                  : "downloadable",
              ...(operation ? { downloaded: operation.downloaded } : {}),
              ...(ready && linkedFrom ? { linkedFrom } : {}),
            };
          }),
        ),
      { concurrency: "unbounded" },
    );
    return { models };
  });

  const freshStatus = (operation: string) =>
    readSettings(operation).pipe(Effect.flatMap(currentStatus));
  const readModels = (includeBenchmarks: boolean) =>
    readSettings("model listing").pipe(
      Effect.flatMap((settings) => listModels(settings, includeBenchmarks)),
    );
  const modelsEffect = readModels(false);

  const requireSupported = Effect.suspend(() =>
    unsupportedReason
      ? Effect.fail(new SpeechUnsupportedPlatformError({ platform, architecture }))
      : Effect.void,
  );

  const finalizeTranscript = (
    text: string,
    options: SpeechTranscriptionOptions,
    language: string | undefined,
  ) => {
    return (
      options.speechRemoveFillerWords
        ? removeSpeechFillerWords(text, language, options.speechCorrectionWord)
        : text
    ).trim();
  };

  const prepareModel = readSettings("model preparation").pipe(
    Effect.flatMap((settings) =>
      exclusive(
        "model preparation",
        requireSupported.pipe(
          Effect.andThen(installedModelPath(selectedModel(settings))),
          Effect.flatMap((modelPath) =>
            attempt("model preparation", (signal) =>
              loadModel(
                modelPath,
                selectedModel(settings),
                AbortSignal.any([signal, lifetime.signal]),
                settings.speechAcceleration,
              ),
            ).pipe(
              Effect.timeout("2 minutes"),
              Effect.catchTags({
                TimeoutError: (cause) =>
                  Effect.fail(new SpeechOperationError({ operation: "model preparation", cause })),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  const silenceModelPath = Effect.fn("SpeechService.silenceModelPath")(function* (
    loaded: LoadedModel,
    options: SpeechTranscriptionOptions,
  ) {
    if (!options.speechSilenceFiltering && (loaded.supportsStreaming || loaded.supportsLongForm))
      return undefined;
    return yield* acquireSilenceModel("recording");
  });

  const transcribe: SpeechService["Service"]["transcribe"] = Effect.fn("SpeechService.transcribe")(
    function* (pcmBytes, options) {
      const settings = yield* readSettings("transcription");
      return yield* exclusive(
        "transcription",
        Effect.gen(function* () {
          yield* requireSupported;
          const pcm = yield* Effect.try({
            try: () => decodeSpeechPcm(pcmBytes),
            catch: (cause) => speechError("transcription", cause),
          });
          if (pcm.length === 0) return "";
          activeTranscriptions += 1;
          return yield* Effect.gen(function* () {
            const definition = selectedModel(settings);
            const language = effectiveSpeechLanguage(definition, options.speechLanguage);
            const translateToEnglish =
              options.speechTranslateToEnglish &&
              definition.supportsTranslation &&
              language !== "en";
            const modelPath = yield* installedModelPath(definition);
            const loaded = yield* Effect.tryPromise({
              try: (signal) =>
                loadModel(
                  modelPath,
                  definition,
                  AbortSignal.any([signal, lifetime.signal]),
                  settings.speechAcceleration,
                ),
              catch: (cause) => speechError("model preparation", cause),
            });
            const vadPath = yield* silenceModelPath(loaded, options);
            const dictionary = normalizeSpeechCustomWords(options.speechCustomWords);
            const customWords = dictionary.map(({ term }) => term);
            // The vocabulary capability guarantees plain transcription, not translation.
            const vocabularyFor = (inference: LoadedModel) =>
              inference.supportsVocabulary && !translateToEnglish ? customWords : [];
            const transcribeWith = (inference: LoadedModel) =>
              Effect.tryPromise({
                try: (signal) => {
                  // Interruption kills the isolated process; the next request reloads the model.
                  signal.addEventListener("abort", () => dropModel(inference), { once: true });
                  const hint = nativeSpeechLanguage(inference.languages, language);
                  return inference.transcribe(
                    pcm,
                    {
                      timestamps: "none",
                      ...(hint ? { language: hint } : {}),
                      ...(translateToEnglish
                        ? { task: "translate" as const, targetLanguage: "en" as const }
                        : {}),
                      ...(vocabularyFor(inference).length > 0 ? { vocabulary: customWords } : {}),
                    },
                    options.speechSilenceFiltering,
                    vadPath,
                  );
                },
                catch: (cause) => {
                  dropModel(inference);
                  return speechError("inference", cause);
                },
              });
            let inference = loaded;
            const result = yield* transcribeWith(loaded).pipe(
              Effect.catch((error) => {
                if (!canRetryOnCpu(settings.speechAcceleration, loaded)) return Effect.fail(error);
                return Effect.tryPromise({
                  try: (signal) =>
                    loadModel(
                      modelPath,
                      definition,
                      AbortSignal.any([signal, lifetime.signal]),
                      "cpu",
                    ),
                  catch: (cause) => speechError("model preparation", cause),
                }).pipe(
                  Effect.flatMap((cpu) => {
                    autoCpuModel = definition.id;
                    inference = cpu;
                    return transcribeWith(cpu);
                  }),
                );
              }),
            );
            const correct = makeSpeechTextCorrector(
              vocabularyFor(inference).length > 0 ? [] : customWords,
              dictionary,
            );
            return finalizeTranscript(
              correct(result.text),
              options,
              translateToEnglish ? "en" : language === "auto" ? undefined : language,
            );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                activeTranscriptions -= 1;
              }),
            ),
          );
        }),
      );
    },
  );

  // Stream setup shares the public startStream span.
  const openStream = Effect.fnUntraced(function* (options: SpeechTranscriptionOptions) {
    const operation = "streaming transcription";
    yield* requireSupported;
    const released = Promise.withResolvers<void>();
    // @effect-diagnostics-next-line abortControllerInEffect:off - Stream cancellation must abort native work independently of the caller fiber.
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    let finished = false;
    let closed = false;
    let started = false;
    let loaded: LoadedModel | undefined;
    yield* Effect.acquireRelease(
      Effect.suspend(() => {
        if (closing || operationBusy()) return Effect.fail(new SpeechBusyError({ operation }));
        activeOperation = released.promise;
        activeTranscriptions += 1;
        return Effect.void;
      }),
      () =>
        Effect.sync(() => {
          activeTranscriptions -= 1;
          if (activeOperation === released.promise) activeOperation = undefined;
          scheduleUnload();
          released.resolve();
        }),
    );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true;
        if (!finished) {
          const dispose = Effect.promise(async () => {
            const pending = loading;
            controller.abort();
            await pending?.catch(() => undefined);
            if (loaded) {
              forgetModel(loaded);
              await loaded.dispose();
            }
          });
          if (loaded && started) {
            yield* attempt("reset stream", () => loaded!.reset()).pipe(
              Effect.timeout("2500 millis"),
              Effect.catch(() => dispose),
            );
          } else {
            yield* dispose;
          }
        }
      }),
    );
    const settings = yield* readSettings(operation);
    const definition = selectedModel(settings);
    const language = effectiveSpeechLanguage(definition, options.speechLanguage);
    const dictionary = normalizeSpeechCustomWords(options.speechCustomWords);
    const customWords = dictionary.map(({ term }) => term);
    let correct = makeSpeechTextCorrector(customWords, dictionary);
    const modelPath = yield* installedModelPath(definition);
    let streamModel = yield* attempt(operation, () =>
      loadModel(modelPath, definition, signal, settings.speechAcceleration),
    );
    loaded = streamModel;
    const vadPath = yield* silenceModelPath(streamModel, options);
    let translateToEnglish = false;
    const beginStream = async () => {
      translateToEnglish =
        options.speechTranslateToEnglish &&
        !streamModel.supportsStreaming &&
        streamModel.supportsTranslation &&
        language !== "en";
      const vocabulary =
        streamModel.supportsVocabulary && !translateToEnglish && customWords.length
          ? customWords
          : undefined;
      const hint = nativeSpeechLanguage(streamModel.languages, language);
      await streamModel.begin(
        {
          timestamps: "none",
          ...(hint ? { language: hint } : {}),
          ...(translateToEnglish ? { task: "translate", targetLanguage: "en" } : {}),
          ...(vocabulary ? { vocabulary } : {}),
        },
        options.speechSilenceFiltering,
        vadPath,
      );
      correct = makeSpeechTextCorrector(vocabulary ? [] : customWords, dictionary);
      started = true;
    };
    // Audio already fed is kept so a CPU restart can replay it; the limit caps it at one recording.
    const received: Float32Array[] = [];
    let retriedOnCpu = false;
    const recoverOnCpu = async (cause: unknown) => {
      started = false;
      if (closed || signal.aborted || retriedOnCpu) throw cause;
      if (!canRetryOnCpu(settings.speechAcceleration, streamModel)) throw cause;
      retriedOnCpu = true;
      forgetModel(streamModel);
      await streamModel.dispose();
      if (closed || signal.aborted) throw cause;
      streamModel = await loadModel(modelPath, definition, signal, "cpu");
      autoCpuModel = definition.id;
      loaded = streamModel;
      await beginStream();
      let update: Awaited<ReturnType<LoadedModel["feed"]>> | undefined;
      for (const chunk of received) {
        if (closed || signal.aborted) throw new Error("Speech stream is closed.");
        update = await streamModel.feed(chunk);
      }
      return update;
    };
    yield* attempt(operation, async () => {
      try {
        await beginStream();
      } catch (cause) {
        await recoverOnCpu(cause);
      }
    });
    let byteLength = 0;
    let busy = false;
    // Client revisions stay monotonic across a native restart, whose own counter resets.
    let revisionBase = 0;
    let lastNativeRevision = 0;
    const run = <A>(work: () => Promise<A>) =>
      attempt(operation, async () => {
        if (busy || finished || closed || !started || signal.aborted)
          throw new Error("Speech stream is not ready.");
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
          const pcm = decodeSpeechPcm(bytes);
          byteLength += bytes.byteLength;
          received.push(pcm);
          let update: Awaited<ReturnType<LoadedModel["feed"]>> | undefined;
          try {
            update = await streamModel.feed(pcm);
          } catch (cause) {
            update = await recoverOnCpu(cause);
            revisionBase += lastNativeRevision;
            lastNativeRevision = 0;
          }
          if (update) lastNativeRevision = update.revision;
          return {
            revision: revisionBase + (update?.revision ?? lastNativeRevision),
            text: update?.text
              ? {
                  committed: correct(update.text.committed),
                  tentative: correct(update.text.tentative),
                }
              : null,
          };
        }),
      finish: run(async () => {
        let text: string;
        try {
          text = await streamModel.finish().catch(async (cause: unknown) => {
            await recoverOnCpu(cause);
            if (closed || signal.aborted) throw cause;
            return streamModel.finish();
          });
        } catch (cause) {
          started = false;
          throw cause;
        }
        finished = true;
        return finalizeTranscript(
          correct(text),
          options,
          translateToEnglish ? "en" : language === "auto" ? undefined : language,
        );
      }),
    };
  });

  return SpeechService.of({
    status: freshStatus("status"),
    models: readModels,
    prepareModel,
    transcribe,
    startStream: Effect.fn("SpeechService.startStream")(function* (options) {
      const session = yield* Scope.fork(yield* Effect.scope);
      return yield* openStream(options).pipe(
        Scope.provide(session),
        Effect.onError((cause) => Scope.close(session, Exit.failCause(cause))),
      );
    }),
    downloadModel: Effect.fn("SpeechService.downloadModel")((modelId) =>
      requireSupported.pipe(
        Effect.andThen(download(modelId)),
        Effect.catchTags({ SpeechDownloadCancelledError: () => Effect.void }),
        Effect.andThen(modelsEffect),
      ),
    ),
    selectModel: Effect.fn("SpeechService.selectModel")((modelId) =>
      exclusive(
        "model selection",
        attempt("model selection", async () => {
          if (!getSpeechModel(modelId)) throw new SpeechModelNotFoundError({ modelId });
          await disposeModel();
        }),
      ).pipe(
        Effect.andThen(writeSettings("model selection", { speechModelId: modelId })),
        Effect.andThen(modelsEffect),
      ),
    ),
    cancelDownload: Effect.fn("SpeechService.cancelDownload")((modelId) =>
      Effect.suspend(() =>
        downloading?.modelId === modelId
          ? Deferred.await(downloading.fiber).pipe(Effect.flatMap(Fiber.interrupt))
          : Effect.void,
      ).pipe(Effect.andThen(modelsEffect)),
    ),
    removeModel: Effect.fn("SpeechService.removeModel")((modelId) =>
      readSettings("model removal").pipe(
        Effect.flatMap((settings) =>
          exclusive(
            "model removal",
            Effect.gen(function* () {
              const definition = getSpeechModel(modelId);
              if (!definition) return yield* new SpeechModelNotFoundError({ modelId });
              yield* attempt("model removal", async () => {
                await loading?.catch(() => undefined);
                if (loadedModelId === modelId) await disposeModel();
              });
              yield* store
                .remove(definition)
                .pipe(Effect.mapError((cause) => speechError("model removal", cause)));
              if (selectedModel(settings).id !== modelId) return undefined;
              const candidates = yield* Effect.forEach(
                SPEECH_MODELS.filter((candidate) => candidate.id !== modelId),
                (candidate) =>
                  store.isReady(candidate).pipe(Effect.map((ready) => ({ candidate, ready }))),
                { concurrency: "unbounded" },
              );
              return candidates.find(({ ready }) => ready)?.candidate.id;
            }),
          ).pipe(
            Effect.flatMap((replacementId) =>
              replacementId
                ? writeSettings("model removal", { speechModelId: replacementId }).pipe(
                    Effect.andThen(modelsEffect),
                  )
                : modelsEffect,
            ),
          ),
        ),
      ),
    ),
    linkModels: Effect.fn("SpeechService.linkModels")(function* (source) {
      yield* requireSupported;
      const settings = yield* readSettings("model linking");
      const linked = yield* exclusive(
        "model linking",
        store
          .link(SPEECH_MODELS, source)
          .pipe(Effect.mapError((cause) => speechError("model linking", cause))),
      );
      const first = linked[0];
      if (first === undefined) return yield* new SpeechModelNotFoundError({ modelId: source });
      if (!(yield* store.isReady(selectedModel(settings))))
        yield* writeSettings("model linking", { speechModelId: first });
      return yield* modelsEffect;
    }),
    updateAcceleration: Effect.fn("SpeechService.updateAcceleration")((acceleration) =>
      writeSettings("acceleration update", { speechAcceleration: acceleration }).pipe(
        Effect.andThen(freshStatus("acceleration update")),
      ),
    ),
    updateModelUnloadTimeout: Effect.fn("SpeechService.updateModelUnloadTimeout")((timeout) =>
      writeSettings("model unload timeout update", { speechModelUnloadTimeout: timeout }).pipe(
        Effect.andThen(freshStatus("model unload timeout update")),
      ),
    ),
  });
});

export const layer = Layer.effect(SpeechService, make);
