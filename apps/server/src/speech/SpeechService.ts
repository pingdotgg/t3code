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
  const pcm = new Float32Array(pcmBytes.slice().buffer);
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

  const selectedModel = async () => {
    const settings = await Effect.runPromise(serverSettings.getSettings);
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

  const loadModel = async (signal = lifetime.signal) => {
    const definition = await selectedModel();
    if (model && loadedModelId === definition.id) return model;
    if (model) {
      await model.dispose();
      model = undefined;
      loadedModelId = undefined;
    }
    const pending =
      loading ??
      download(definition.id, signal)
        .then(async (modelPath) => {
          const loaded = await loadNativeSpeechModel(modelPath, signal);
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

  const currentStatus = async (): Promise<EnvironmentSpeechStatus> => {
    if (unsupportedReason) return { supported: false, reason: unsupportedReason };
    const definition = await selectedModel();
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
    };
  };

  const listModels = async () => {
    const selected = await selectedModel();
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
      loaded = yield* attempt(operation, async () => {
        const prepared = await loadModel(signal);
        if (!prepared.supportsStreaming)
          throw new Error("The selected model does not support streaming.");
        await prepared.begin();
        return prepared;
      });
      const streamModel = loaded;
      let byteLength = 0;
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
            return streamModel.feed(pcm);
          }),
        finish: run(async () => {
          const text = await streamModel.finish();
          finished = true;
          return text.trim();
        }),
      };
    }),
    status: attempt("status", currentStatus),
    models: attempt("model listing", listModels),
    downloadModel: (modelId) =>
      exclusive("model download", async () => {
        if (unsupportedReason) throw new SpeechUnsupportedPlatformError({ platform, architecture });
        await download(modelId);
        return currentStatus();
      }),
    selectModel: (modelId) =>
      exclusive("model selection", async () => {
        if (!getSpeechModel(modelId)) throw new SpeechModelNotFoundError({ modelId });
        await model?.dispose();
        model = undefined;
        loadedModelId = undefined;
        loading = undefined;
        await Effect.runPromise(serverSettings.updateSettings({ speechModelId: modelId }));
        return currentStatus();
      }),
    cancelDownload: (modelId) =>
      attempt("model download cancellation", async () => {
        if (downloading?.modelId === modelId) downloading.controller.abort();
        return currentStatus();
      }),
    transcribe: (pcmBytes) =>
      exclusive("transcription", async () => {
        if (unsupportedReason) throw new SpeechUnsupportedPlatformError({ platform, architecture });
        const pcm = decodeSpeechPcm(pcmBytes);
        if (pcm.length === 0) return "";
        activeTranscriptions += 1;
        try {
          const loaded = await loadModel().catch((cause) => {
            throw new SpeechOperationError({ operation: "model preparation", cause });
          });
          const result = await loaded.transcribe(pcm, { timestamps: "none" }).catch((cause) => {
            if (model === loaded) {
              model = undefined;
              loadedModelId = undefined;
              loading = undefined;
            }
            throw new SpeechOperationError({ operation: "inference", cause });
          });
          return result.text.trim();
        } finally {
          activeTranscriptions -= 1;
        }
      }),
    removeModel: (modelId) =>
      exclusive("model removal", async () => {
        const definition = getSpeechModel(modelId);
        if (!definition) throw new SpeechModelNotFoundError({ modelId });
        const selected = await selectedModel();
        await loading?.catch(() => undefined);
        if (loadedModelId === modelId) {
          await model?.dispose();
          model = undefined;
          loadedModelId = undefined;
          loading = undefined;
        }
        await removeSpeechModel(modelDirectory, definition);
        if (selected.id === modelId) {
          const candidates = await Promise.all(
            SPEECH_MODELS.filter((candidate) => candidate.id !== modelId).map(
              async (candidate) => ({
                candidate,
                ready: await isSpeechModelReady(modelDirectory, candidate),
              }),
            ),
          );
          const replacement = candidates.find(({ ready }) => ready)?.candidate;
          if (replacement)
            await Effect.runPromise(
              serverSettings.updateSettings({ speechModelId: replacement.id }),
            );
        }
        return currentStatus();
      }),
  });
});

export const layer = Layer.effect(SpeechService, make);
