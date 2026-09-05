import type { EnvironmentSpeechStatus } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import {
  downloadSpeechModel,
  isSpeechModelReady,
  removeSpeechModel,
  SPEECH_MODEL,
} from "./model.ts";

const SAMPLE_RATE = 16_000;
export const MAX_SPEECH_DURATION_SECONDS = 5 * 60;
export const MAX_SPEECH_BYTES =
  SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT * MAX_SPEECH_DURATION_SECONDS;
const MIN_CAPTURE_RMS = 0.0005;

export class SpeechInvalidAudioError extends Schema.TaggedErrorClass<SpeechInvalidAudioError>()(
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
  return Math.sqrt(energy / pcm.length) < MIN_CAPTURE_RMS ? new Float32Array() : pcm;
}

export class SpeechOperationError extends Schema.TaggedErrorClass<SpeechOperationError>()(
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

export class SpeechUnsupportedPlatformError extends Schema.TaggedErrorClass<SpeechUnsupportedPlatformError>()(
  "SpeechUnsupportedPlatformError",
  { platform: Schema.String, architecture: Schema.String },
) {}

export class SpeechBusyError extends Schema.TaggedErrorClass<SpeechBusyError>()("SpeechBusyError", {
  operation: Schema.String,
}) {}

type SpeechError =
  | SpeechOperationError
  | SpeechInvalidAudioError
  | SpeechUnsupportedPlatformError
  | SpeechBusyError;

const isSpeechError = Schema.is(
  Schema.Union([
    SpeechInvalidAudioError,
    SpeechUnsupportedPlatformError,
    SpeechBusyError,
    SpeechOperationError,
  ]),
);

type LoadedModel = {
  readonly transcribe: (
    pcm: Float32Array,
    options: { readonly timestamps: "none"; readonly language: "en" },
  ) => Promise<{ readonly text: string }>;
  readonly dispose: () => void;
};

export class SpeechService extends Context.Service<
  SpeechService,
  {
    readonly status: Effect.Effect<EnvironmentSpeechStatus, SpeechOperationError>;
    readonly transcribe: (pcmBytes: Uint8Array) => Effect.Effect<string, SpeechError>;
    readonly removeModel: Effect.Effect<EnvironmentSpeechStatus, SpeechError>;
  }
>()("t3/speech/SpeechService") {}

function supported(platform: string, architecture: string): string | null {
  const tuple = `${platform}-${architecture}`;
  return new Set(["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64", "linux-arm64"]).has(tuple)
    ? null
    : `voice transcription is not available on ${tuple}`;
}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const unsupportedReason = supported(platform, architecture);
  const modelDirectory = path.join(config.stateDir, "speech", "models");
  let model: LoadedModel | undefined;
  let loading: Promise<LoadedModel> | undefined;
  let activeTranscriptions = 0;
  let activeOperation: Promise<unknown> | undefined;
  let closing = false;

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closing = true;
      await activeOperation?.catch(() => undefined);
      model?.dispose();
      model = undefined;
      loading = undefined;
    }),
  );

  const loadModel = async (signal?: AbortSignal) => {
    if (model) return model;
    loading ??= downloadSpeechModel(modelDirectory, signal)
      .then(async (modelPath) => {
        const { TranscribeModel } = await import("transcribe-cpp");
        const loaded = await TranscribeModel.load(modelPath, { backend: "cpu" });
        model = loaded;
        return loaded;
      })
      .catch((error) => {
        loading = undefined;
        throw error;
      });
    return loading;
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
    return {
      supported: true,
      state:
        activeTranscriptions > 0
          ? "transcribing"
          : (await isSpeechModelReady(modelDirectory))
            ? "ready"
            : "missing-model",
      model: SPEECH_MODEL.name,
    };
  };

  return SpeechService.of({
    status: attempt("status", currentStatus),
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
          const result = await loaded
            .transcribe(pcm, { timestamps: "none", language: "en" })
            .catch((cause) => {
              throw new SpeechOperationError({ operation: "inference", cause });
            });
          return result.text.trim();
        } finally {
          activeTranscriptions -= 1;
        }
      }),
    removeModel: exclusive("model removal", async () => {
      await loading?.catch(() => undefined);
      model?.dispose();
      model = undefined;
      loading = undefined;
      await removeSpeechModel(modelDirectory);
      return currentStatus();
    }),
  });
});

export const layer = Layer.effect(SpeechService, make);
