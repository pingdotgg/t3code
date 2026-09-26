import type {
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
  SpeechAcceleration,
  SpeechCustomWords,
  SpeechLanguage,
  SpeechModelUnloadTimeout,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { SPEECH_STREAM_MAX_CHUNK_BYTES } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { listNativeSpeechGpuDevices, loadNativeSpeechModel } from "./native.ts";
import {
  DEFAULT_SPEECH_MODEL_ID,
  downloadSpeechModel,
  effectiveSpeechLanguage,
  getSpeechModel,
  isSpeechModelReady,
  removeSpeechModel,
  SPEECH_MODELS,
} from "./model.ts";
import {
  applySpeechCustomWords,
  applySpeechAliases,
  makeSpeechAliasReplacer,
  normalizeSpeechCustomWords,
  transcriptionCustomWords,
} from "./customWords.ts";
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

const resetStreamOrThrow = (model: LoadedModel) =>
  Effect.tryPromise({
    try: () => model.reset(),
    catch: (cause) => new SpeechOperationError({ operation: "stream reset", cause }),
  }).pipe(Effect.timeout("2500 millis"), Effect.interruptible);

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
    readonly prepareModel: Effect.Effect<void, SpeechError>;
    readonly updateCustomWords: (
      words: SpeechCustomWords,
    ) => Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
    readonly updateFillerWordRemoval: (
      enabled: boolean,
    ) => Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
    readonly updateAcceleration: (
      acceleration: SpeechAcceleration,
    ) => Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
    readonly updateModelUnloadTimeout: (
      timeout: SpeechModelUnloadTimeout,
    ) => Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
    readonly updateLanguage: (
      language: SpeechLanguage,
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
  const clock = yield* Clock.Clock;
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;
  const unsupportedReason = supported(platform, architecture);
  const modelDirectory = path.join(config.stateDir, "speech", "models");
  let model: LoadedModel | undefined;
  let loadedModelId: string | undefined;
  let loadedAcceleration: string | undefined;
  let gpuDevices: ReturnType<typeof listNativeSpeechGpuDevices> | undefined;
  let loading: Promise<LoadedModel> | undefined;
  let downloading:
    | { modelId: string; downloaded: number; verifying: boolean; controller: AbortController }
    | undefined;
  let activeTranscriptions = 0;
  let activeOperation: Promise<unknown> | undefined;
  // Batch inference detached by cancellation: still running in the isolated
  // process, no longer awaited by anyone. New work preempts it on arrival.
  let orphaned: { done: Promise<void>; target: LoadedModel } | undefined;
  let closing = false;
  const lifetime = new AbortController();
  let unloadTimeout: SpeechModelUnloadTimeout = "min_15";
  const unloadRequests = yield* Queue.sliding<{ deadline: number; generation: number } | null>(1);
  let unloadGeneration = 0;
  let lastUse = 0;
  const unloadMilliseconds: Record<Exclude<SpeechModelUnloadTimeout, "never">, number> = {
    immediately: 0,
    min_2: 2 * 60_000,
    min_5: 5 * 60_000,
    min_10: 10 * 60_000,
    min_15: 15 * 60_000,
    hour_1: 60 * 60_000,
  };
  const clearUnloadTimer = () => {
    unloadGeneration += 1;
    Queue.offerUnsafe(unloadRequests, null);
  };
  const scheduleUnload = (minimumDelay = 0) => {
    clearUnloadTimer();
    if (!model || closing || unloadTimeout === "never") return;
    const delay = Math.max(minimumDelay, unloadMilliseconds[unloadTimeout] - (now() - lastUse));
    Queue.offerUnsafe(unloadRequests, { deadline: now() + delay, generation: unloadGeneration });
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closing = true;
      clearUnloadTimer();
      lifetime.abort();
      await model?.dispose();
      model = undefined;
      loadedModelId = undefined;
      loadedAcceleration = undefined;
      loading = undefined;
    }),
  );

  yield* Stream.fromQueue(unloadRequests).pipe(
    Stream.switchMap((request) =>
      request === null
        ? Stream.empty
        : Stream.fromEffect(
            Effect.gen(function* () {
              yield* Effect.sleep(Math.max(0, request.deadline - now()));
              if (closing || request.generation !== unloadGeneration) return;
              if (activeOperation || activeTranscriptions || loading) {
                scheduleUnload(1000);
                return;
              }
              const loaded = model;
              model = undefined;
              loadedModelId = undefined;
              loadedAcceleration = undefined;
              if (!loaded) return;
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const pending = Promise.resolve().then(() => loaded.dispose());
                  activeOperation = pending;
                  yield* Effect.promise(() => pending.catch(() => undefined)).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (activeOperation === pending) activeOperation = undefined;
                      }),
                    ),
                  );
                }),
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
    acceleration = "auto",
  ) => {
    if (model && loadedModelId === definition.id && loadedAcceleration === acceleration) {
      lastUse = now();
      scheduleUnload();
      return model;
    }
    if (model) {
      await model.dispose();
      model = undefined;
      loadedModelId = undefined;
      loadedAcceleration = undefined;
    }
    const pending =
      loading ??
      download(definition.id, signal)
        .then(async (modelPath) => {
          const loaded = await loadNativeSpeechModel(modelPath, signal, undefined, acceleration);
          if (closing) {
            await loaded.dispose();
            throw new SpeechBusyError({ operation: "model preparation" });
          }
          model = loaded;
          lastUse = now();
          // Batch preparation can precede up to five minutes of recording.
          scheduleUnload();
          loadedModelId = definition.id;
          loadedAcceleration = acceleration;
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

  const speechError = (operation: string, cause: unknown): SpeechError =>
    isSpeechError(cause) ? cause : new SpeechOperationError({ operation, cause });

  const attemptSpeech = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => speechError(operation, cause),
    });

  // Interruptible variant of `exclusive`: the slot is released by an Effect
  // finalizer, so interrupting the fiber frees it immediately instead of
  // waiting for dangling native work to settle.
  const exclusiveEffect = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend<A, E | SpeechBusyError, never>(() => {
        if (closing || activeOperation) return Effect.fail(new SpeechBusyError({ operation }));
        const gate = Promise.withResolvers<void>();
        activeOperation = gate.promise;
        return restore(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (activeOperation === gate.promise) activeOperation = undefined;
              lastUse = now();
              scheduleUnload(
                operation === "model preparation" ? MAX_SPEECH_DURATION_SECONDS * 1000 : 0,
              );
              gate.resolve();
            }),
          ),
        );
      }),
    );

  // Runs one native transcription so fiber interruption detaches the
  // underlying work instead of leaving it holding the busy slot: the isolated
  // process keeps running in the background and the model stays warm. New work
  // preempts it on arrival (see preemptOrphaned).
  const transcribeAbortable = (
    target: LoadedModel,
    pcm: Float32Array,
    options: Parameters<LoadedModel["transcribe"]>[1],
    onAbort: (detached: LoadedModel, settled: Promise<void>) => void,
  ) =>
    Effect.tryPromise({
      try: (signal) =>
        new Promise<Awaited<ReturnType<LoadedModel["transcribe"]>>>((resolve, reject) => {
          const raw = target.transcribe(pcm, options);
          const settled = raw.then(
            () => undefined,
            () => undefined,
          );
          const abort = () => {
            onAbort(target, settled);
            reject(signal.reason ?? new Error("Speech transcription was cancelled."));
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          raw.then(
            (result) => {
              signal.removeEventListener("abort", abort);
              resolve(result);
            },
            (cause) => {
              signal.removeEventListener("abort", abort);
              reject(cause);
            },
          );
        }),
      catch: (cause) => speechError("transcription", cause),
    });

  // Drops the cached model and stops its isolated process. The next
  // transcription reloads instead of talking to a dead process.
  const dropCachedModel = (target: LoadedModel) => {
    if (model === target) {
      model = undefined;
      loadedModelId = undefined;
      loadedAcceleration = undefined;
      loading = undefined;
    }
    try {
      const stopped: unknown = target.dispose();
      if (stopped instanceof Promise) stopped.catch(() => undefined);
    } catch {
      // The isolated process is already gone.
    }
  };

  // Remembers cancelled batch inference without stopping it, so an idle cancel
  // keeps a warm model. A superseded orphan from an older generation is dead
  // weight and gets stopped right away.
  const detachTranscribeModel = (target: LoadedModel, settled: Promise<void>) => {
    const previous = orphaned;
    orphaned = { done: settled, target };
    if (previous && previous.target !== target) dropCachedModel(previous.target);
  };

  // Grace for abandoned inference to finish before new work kills it. Lets a
  // nearly done transcription keep the model warm while cutting off a long one.
  const ORPHANED_TRANSCRIPTION_GRACE_MS = 2_500;

  // Runs before any model use: if cancelled batch inference is still running
  // on the cached model, wait briefly for it, else stop it and reload below.
  const preemptOrphaned = Effect.gen(function* () {
    const orphan = orphaned;
    if (!orphan || orphan.target !== model) {
      if (orphaned === orphan) orphaned = undefined;
      return;
    }
    const settled = yield* Effect.tryPromise({
      try: () => orphan.done,
      catch: (cause) => speechError("abandoned transcription", cause),
    }).pipe(
      Effect.as(true),
      Effect.timeoutOrElse({
        duration: ORPHANED_TRANSCRIPTION_GRACE_MS,
        orElse: () => Effect.succeed(false),
      }),
    );
    if (orphaned !== orphan) return;
    orphaned = undefined;
    if (settled || orphan.target !== model) return;
    dropCachedModel(orphan.target);
  });

  const readSettings = (operation: string) =>
    serverSettings.getSettings.pipe(
      Effect.tap((settings) =>
        Effect.sync(() => {
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
          lastUse = now();
          scheduleUnload(
            operation === "model preparation" ? MAX_SPEECH_DURATION_SECONDS * 1000 : 0,
          );
        }
      },
      catch: (cause) => speechError(operation, cause),
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
      language: settings.speechLanguage,
      effectiveLanguage: effectiveSpeechLanguage(definition, settings.speechLanguage),
      acceleration: settings.speechAcceleration,
      modelUnloadTimeout: settings.speechModelUnloadTimeout,
      gpuDevices: await (gpuDevices ??= listNativeSpeechGpuDevices().catch(() => [])),
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
            supportsLanguageDetection: definition.supportsLanguageDetection,
            active: ready && selected.id === definition.id,
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
    prepareModel: readSettings("model preparation").pipe(
      Effect.flatMap((settings) =>
        exclusiveEffect(
          "model preparation",
          preemptOrphaned.pipe(
            Effect.andThen(
              // Keep ownership until the native load settles, even if its request is cancelled.
              attemptSpeech("model preparation", async () => {
                if (unsupportedReason)
                  throw new SpeechUnsupportedPlatformError({ platform, architecture });
                await loadModel(
                  selectedModel(settings),
                  lifetime.signal,
                  settings.speechAcceleration,
                );
              }).pipe(Effect.uninterruptible),
            ),
          ),
        ),
      ),
    ),
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
      let started = false;
      let loaded: LoadedModel | undefined;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (!finished) {
            const disposeStream = Effect.promise(async () => {
              controller.abort();
              if (loaded ?? loading) {
                await loading?.catch(() => undefined);
                await (loaded ?? model)?.dispose();
                model = undefined;
                loadedModelId = undefined;
                loadedAcceleration = undefined;
              }
            });
            if (loaded && started) {
              yield* resetStreamOrThrow(loaded).pipe(Effect.catch(() => disposeStream));
            } else {
              yield* disposeStream;
            }
          }
          activeTranscriptions -= 1;
          if (activeOperation === released.promise) activeOperation = undefined;
          lastUse = now();
          scheduleUnload();
          released.resolve();
        }),
      );
      const settings = yield* readSettings("custom words loading");
      const customWords = transcriptionCustomWords(settings);
      const dictionary = normalizeSpeechCustomWords(settings.speechCustomWords);
      const replaceAliases = makeSpeechAliasReplacer(dictionary);
      const correct = (text: string) => replaceAliases(applySpeechCustomWords(text, customWords));
      const removeFillerWords = settings.speechRemoveFillerWords;
      const definition =
        getSpeechModel(settings.speechModelId) ?? getSpeechModel(DEFAULT_SPEECH_MODEL_ID)!;
      const language = effectiveSpeechLanguage(definition, settings.speechLanguage);
      const fillerWordLanguage = language === "auto" ? undefined : language;
      yield* preemptOrphaned;
      const preparation = yield* attemptSpeech(operation, async () => {
        const startedAt = performance.now();
        const prepared = await loadModel(definition, signal, settings.speechAcceleration);
        loaded = prepared;
        if (!prepared.supportsStreaming)
          throw new Error("The selected model does not support streaming.");
        await prepared.begin(language === "auto" ? undefined : language);
        started = true;
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
        attemptSpeech(operation, async () => {
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
                      committed: correct(update.text.committed),
                      tentative: correct(update.text.tentative),
                    }
                  : null,
              };
            } catch (cause) {
              if (
                usedCpuFallback ||
                settings.speechAcceleration !== "auto" ||
                streamModel.backend.toLowerCase() === "cpu"
              )
                throw cause;
              usedCpuFallback = true;
              await streamModel.dispose();
              if (model === streamModel) {
                model = undefined;
                loadedModelId = undefined;
                loadedAcceleration = undefined;
                loading = undefined;
              }
              streamModel = await loadModel(definition, signal, "cpu");
              loaded = streamModel;
              await streamModel.begin(language === "auto" ? undefined : language);
              let update: Awaited<ReturnType<LoadedModel["feed"]>> | undefined;
              for (const chunk of received) update = await streamModel.feed(chunk);
              if (!update) throw cause;
              return {
                ...update,
                text: update.text
                  ? {
                      committed: correct(update.text.committed),
                      tentative: correct(update.text.tentative),
                    }
                  : null,
              };
            }
          }),
        finish: run(async () => {
          const startedAt = performance.now();
          const corrected = correct(await streamModel.finish());
          const text = removeFillerWords
            ? removeSpeechFillerWords(
                corrected,
                fillerWordLanguage,
                settings.speechPostProcessingEnabled ? settings.speechCorrectionWord : undefined,
              )
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
        loadedAcceleration = undefined;
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
    updateAcceleration: (acceleration) =>
      writeSettings("acceleration update", { speechAcceleration: acceleration }).pipe(
        Effect.andThen(freshStatus("acceleration update")),
      ),
    updateModelUnloadTimeout: (timeout) =>
      writeSettings("model unload timeout update", { speechModelUnloadTimeout: timeout }).pipe(
        Effect.andThen(freshStatus("model unload timeout update")),
      ),
    updateLanguage: (language) =>
      writeSettings("language update", { speechLanguage: language }).pipe(
        Effect.andThen(freshStatus("language update")),
      ),
    transcribe: (pcmBytes) =>
      readSettings("transcription").pipe(
        Effect.flatMap((settings) =>
          exclusiveEffect(
            "transcription",
            Effect.gen(function* () {
              if (unsupportedReason)
                return yield* new SpeechUnsupportedPlatformError({ platform, architecture });
              const pcm = yield* Effect.try({
                try: () => decodeSpeechPcm(pcmBytes),
                catch: (cause) => speechError("transcription", cause),
              });
              if (pcm.length === 0)
                return { text: "", backend: "none", prepareDurationMs: 0, inferenceDurationMs: 0 };
              activeTranscriptions += 1;
              return yield* Effect.gen(function* () {
                const definition = selectedModel(settings);
                const language = effectiveSpeechLanguage(definition, settings.speechLanguage);
                const prepareStartedAt = performance.now();
                yield* preemptOrphaned;
                const loaded = yield* Effect.tryPromise({
                  try: (signal) =>
                    loadModel(
                      definition,
                      AbortSignal.any([signal, lifetime.signal]),
                      settings.speechAcceleration,
                    ),
                  catch: (cause) => speechError("model preparation", cause),
                });
                const prepareDurationMs = performance.now() - prepareStartedAt;
                const inferenceStartedAt = performance.now();
                let inferenceModel = loaded;
                const customWords = transcriptionCustomWords(settings);
                const dictionary = normalizeSpeechCustomWords(settings.speechCustomWords);
                const removeFillerWords = settings.speechRemoveFillerWords;
                const fillerWordLanguage = language === "auto" ? undefined : language;
                const options = {
                  timestamps: "none" as const,
                  ...(language === "auto" ? {} : { language }),
                  ...(customWords.length > 0 && loaded.supportsInitialPrompt
                    ? {
                        family: {
                          kind: "whisper" as const,
                          initialPrompt: customWords.join(", "),
                        },
                      }
                    : {}),
                };
                const result = yield* transcribeAbortable(
                  inferenceModel,
                  pcm,
                  options,
                  detachTranscribeModel,
                ).pipe(
                  Effect.catch((cause) =>
                    Effect.gen(function* () {
                      if (model === inferenceModel) {
                        model = undefined;
                        loadedModelId = undefined;
                        loadedAcceleration = undefined;
                        loading = undefined;
                      }
                      if (
                        settings.speechAcceleration !== "auto" ||
                        inferenceModel.backend.toLowerCase() === "cpu"
                      ) {
                        yield* Effect.tryPromise({
                          try: () => Promise.resolve().then(() => inferenceModel.dispose()),
                          catch: (disposeCause) => speechError("transcription", disposeCause),
                        });
                        return yield* new SpeechOperationError({ operation: "inference", cause });
                      }
                      yield* Effect.tryPromise({
                        try: () => Promise.resolve().then(() => inferenceModel.dispose()),
                        catch: (disposeCause) => speechError("transcription", disposeCause),
                      });
                      const cpu = yield* Effect.tryPromise({
                        try: (signal) =>
                          loadModel(definition, AbortSignal.any([signal, lifetime.signal]), "cpu"),
                        catch: (loadCause) => speechError("transcription", loadCause),
                      });
                      inferenceModel = cpu;
                      return yield* transcribeAbortable(
                        cpu,
                        pcm,
                        options,
                        detachTranscribeModel,
                      ).pipe(
                        Effect.catch((fallbackCause) => {
                          dropCachedModel(cpu);
                          return Effect.fail(
                            new SpeechOperationError({
                              operation: "inference",
                              cause: fallbackCause,
                            }),
                          );
                        }),
                      );
                    }),
                  ),
                );
                const corrected = applySpeechAliases(
                  loaded.supportsInitialPrompt
                    ? result.text
                    : applySpeechCustomWords(result.text, customWords),
                  dictionary,
                );
                return {
                  text: (removeFillerWords
                    ? removeSpeechFillerWords(
                        corrected,
                        fillerWordLanguage,
                        settings.speechPostProcessingEnabled
                          ? settings.speechCorrectionWord
                          : undefined,
                      )
                    : corrected
                  ).trim(),
                  backend: inferenceModel.backend,
                  prepareDurationMs,
                  inferenceDurationMs: performance.now() - inferenceStartedAt,
                };
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    activeTranscriptions -= 1;
                  }),
                ),
              );
            }),
          ),
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
              loadedAcceleration = undefined;
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
