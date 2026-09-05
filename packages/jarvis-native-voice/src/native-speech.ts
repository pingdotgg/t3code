// oxlint-disable t3code/no-global-process-runtime -- this file is the native voice boundary.
// @effect-diagnostics nodeBuiltinImport:off globalProcess:off globalTimers:off - this is a narrow native boundary for the
// host application. It owns local speech runtimes and keeps native process details out of the UI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import * as NodeTimersPromises from "node:timers/promises";

import { createPocketLifecycle } from "./pocket-lifecycle.ts";
import { startPocketWorker } from "./pocket-worker-client.ts";
import { pocketIdleOffloadMs } from "./pocket-config.ts";
import { classifyVoiceCaptureError, createVoiceCaptureError } from "./voice-capture-error.ts";

export {
  classifyVoiceCaptureError,
  createVoiceCaptureError,
  isVoiceCaptureErrorCode,
  voiceCaptureErrorCodes,
} from "./voice-capture-error.ts";
export type { VoiceCaptureError, VoiceCaptureErrorCode } from "./voice-capture-error.ts";

type SpeechJob = {
  readonly ready?: Promise<void>;
  readonly text: () => string | undefined;
  readonly cancelPending: () => void;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
};

export type NativeSpeechInterruptSource = "tray" | "overlay" | "capture" | "relay";

/**
 * User-facing stop commands cancel playback locally. The speak promise still
 * completes so Host report acknowledgement is independent of whether the user
 * heard the whole sentence.
 */
export function nativeSpeechInterruptPolicy(source: NativeSpeechInterruptSource): {
  readonly accepted: boolean;
  readonly presentInterrupted: boolean;
  readonly completeSpeak: boolean;
} {
  if (source === "relay") {
    return { accepted: false, presentInterrupted: false, completeSpeak: true };
  }
  return {
    accepted: true,
    presentInterrupted: source !== "capture",
    completeSpeak: true,
  };
}

export type LatestSpeechQueue = {
  readonly enqueue: (text: string) => Promise<void>;
  readonly reserve: () => SpeechReservation;
  readonly interrupt: () => void;
  readonly isActive: () => boolean;
};

export type SpeechReservation = {
  /** Makes the reserved item speak. Repeated calls return the same completion. */
  readonly commit: (text: string) => Promise<void>;
  /** Releases the reserved item without speaking. */
  readonly cancel: () => void;
};

/**
 * Keeps spoken reports useful when several arrive together: the sentence in
 * progress can be interrupted, stale queued sentences are discarded, and only
 * the latest state remains. A completion report should not be read minutes late.
 */
export function createLatestSpeechQueue(
  speak: (text: string, signal: AbortSignal) => Promise<void>,
): LatestSpeechQueue {
  let active = false;
  let generation = 0;
  let latest: SpeechJob | undefined;
  let reserved: SpeechJob | undefined;
  let current: SpeechJob | undefined;
  let currentAbort: AbortController | undefined;

  const run = async (job: SpeechJob, runGeneration: number): Promise<void> => {
    const abort = new AbortController();
    current = job;
    currentAbort = abort;
    try {
      if (job.ready !== undefined) await job.ready;
      const text = job.text();
      if (abort.signal.aborted)
        throw new DOMException("Jarvis speech was interrupted.", "AbortError");
      if (text !== undefined) await speak(text, abort.signal);
      job.resolve();
    } catch (cause) {
      if (abort.signal.aborted || (cause instanceof Error && cause.name === "AbortError")) {
        job.resolve();
      } else {
        job.reject(cause);
      }
    } finally {
      if (current === job) current = undefined;
      if (currentAbort === abort) currentAbort = undefined;
      if (generation === runGeneration) {
        const next = reserved ?? latest;
        if (reserved === next) reserved = undefined;
        else latest = undefined;
        if (next === undefined) active = false;
        else void run(next, runGeneration);
      }
    }
  };

  const schedule = (job: SpeechJob, priority: "latest" | "reserved") => {
    if (!active) {
      active = true;
      void run(job, generation);
      return;
    }
    if (priority === "reserved") {
      reserved?.cancelPending();
      reserved?.resolve();
      reserved = job;
      return;
    }
    // A replaced report was intentionally skipped, rather than failed.
    latest?.cancelPending();
    latest?.resolve();
    latest = job;
  };

  return {
    enqueue(text) {
      return new Promise<void>((resolveSpeech, rejectSpeech) => {
        schedule(
          {
            text: () => text,
            cancelPending: () => undefined,
            resolve: resolveSpeech,
            reject: rejectSpeech,
          },
          "latest",
        );
      });
    },
    reserve() {
      let pending = true;
      let reservedText: string | undefined;
      let release: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      let resolveSpeech: () => void = () => undefined;
      let rejectSpeech: (cause: unknown) => void = () => undefined;
      const completion = new Promise<void>((resolve, reject) => {
        resolveSpeech = resolve;
        rejectSpeech = reject;
      });
      const cancelPending = () => {
        if (!pending) return;
        pending = false;
        release();
      };
      const job: SpeechJob = {
        ready,
        text: () => reservedText,
        cancelPending,
        resolve: resolveSpeech,
        reject: rejectSpeech,
      };
      schedule(job, "reserved");
      return {
        commit(text) {
          if (pending) {
            reservedText = text;
            pending = false;
            release();
          }
          return completion;
        },
        cancel() {
          cancelPending();
          if (reserved === job) {
            reserved = undefined;
            resolveSpeech();
          }
        },
      };
    },
    interrupt() {
      reserved?.cancelPending();
      reserved?.resolve();
      reserved = undefined;
      latest?.resolve();
      latest = undefined;
      generation += 1;
      active = false;
      current?.cancelPending();
      currentAbort?.abort();
      currentAbort = undefined;
    },
    isActive() {
      return active;
    },
  };
}

// Keep Pocket warm across the short bursts that make up one task/report. The
// active-retention hook below releases it as soon as attention returns to idle;
// this longer safety window only covers a quiet gap between adjacent reports.
export { pocketIdleOffloadMs };
/** Retired Kokoro idle window. Kept as an alias so upgrades do not break. */
export const kokoroIdleOffloadMs = pocketIdleOffloadMs;

export type NativeSpeechTiming = {
  readonly engineId: "pocket-2026-04" | "kokoro-int8";
  readonly start: "cold" | "warm";
  readonly warmupMs: number;
  /** Time until the first WAV is handed to the native player, not DAC onset. */
  readonly firstPlaybackStartMs?: number;
  readonly firstChunkReadyMs?: number;
  readonly synthesisMs: number;
  readonly totalMs: number;
  readonly synthesisCpuMs: number;
  readonly peakRssBytes: number;
  readonly chunkCount: number;
};

const nativeSpeechTimingListeners = new Set<(timing: NativeSpeechTiming) => void>();

export function onNativeSpeechTiming(listener: (timing: NativeSpeechTiming) => void): () => void {
  nativeSpeechTimingListeners.add(listener);
  return () => nativeSpeechTimingListeners.delete(listener);
}

const pocketLifecycle = createPocketLifecycle({
  startWorker: (signal) => startPocketWorker(signal === undefined ? {} : { signal }),
  schedule: (delayMs, task) => {
    const controller = new AbortController();
    void NodeTimersPromises.setTimeout(delayMs, undefined, { signal: controller.signal })
      .then(task)
      .catch(() => undefined);
    return () => controller.abort();
  },
  idleMs: pocketIdleOffloadMs,
});

async function synthesizeAndPlayPocket(text: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const startedAt = performance.now();
  let firstPlaybackStartMs: number | undefined;
  const metrics = await pocketLifecycle.synthesize(
    text,
    async (outputPath) => {
      if (signal.aborted) return;
      firstPlaybackStartMs ??= performance.now() - startedAt;
      await playNativeCue(outputPath, process.platform, signal);
    },
    signal,
  );
  const timing: NativeSpeechTiming = {
    engineId: "pocket-2026-04",
    start: metrics.cold ? "cold" : "warm",
    warmupMs: metrics.warmupMs ?? 0,
    ...(firstPlaybackStartMs === undefined ? {} : { firstPlaybackStartMs }),
    ...(metrics.firstChunkReadyMs === undefined
      ? {}
      : { firstChunkReadyMs: metrics.firstChunkReadyMs }),
    synthesisMs: metrics.synthesisDurationMs,
    totalMs: performance.now() - startedAt,
    synthesisCpuMs: metrics.synthesisCpuMs,
    peakRssBytes: metrics.peakRssBytes,
    chunkCount: metrics.chunkCount,
  };
  for (const listener of nativeSpeechTimingListeners) {
    try {
      listener(timing);
    } catch {
      // Diagnostics cannot interrupt speech completion.
    }
  }
}

const pocketSpeechQueue = createLatestSpeechQueue(synthesizeAndPlayPocket);

export function setNativeSpeechRetention(retained: boolean): void {
  pocketLifecycle.setRetention(retained);
}

export type ParakeetModelPaths = {
  readonly encoderPath: string;
  readonly decoderPath: string;
  readonly joinerPath: string;
  readonly tokensPath: string;
};

export function parakeetModelPaths(resourceRoot: string): ParakeetModelPaths {
  return {
    encoderPath: NodePath.join(resourceRoot, "encoder.int8.onnx"),
    decoderPath: NodePath.join(resourceRoot, "decoder.int8.onnx"),
    joinerPath: NodePath.join(resourceRoot, "joiner.int8.onnx"),
    tokensPath: NodePath.join(resourceRoot, "tokens.txt"),
  };
}

export function parakeetResourceError(paths: ParakeetModelPaths): Error | undefined {
  const resources: ReadonlyArray<readonly [string, string]> = [
    [paths.encoderPath, "Parakeet encoder"],
    [paths.decoderPath, "Parakeet decoder"],
    [paths.joinerPath, "Parakeet joiner"],
    [paths.tokensPath, "Parakeet tokens"],
  ];
  const missing = resources.find(([path]) => !NodeFS.existsSync(path));
  return missing === undefined
    ? undefined
    : new Error(
        `Speech recognition is unavailable because the bundled ${missing[1]} is missing. Reinstall Jarvis.`,
      );
}

export type ParakeetCapture = {
  readonly result: Promise<string>;
  release(): void;
  cancel(): void;
};

type ParakeetRecognizer = {
  readonly createStream: () => {
    readonly acceptWaveform: (input: {
      readonly samples: Float32Array;
      readonly sampleRate: number;
    }) => void;
  };
  readonly decodeAsync: (stream: unknown) => Promise<{ readonly text?: string }>;
};

type ParakeetResampler = {
  readonly resample: (samples: Float32Array) => Float32Array;
  readonly flush: (samples: Float32Array) => Float32Array;
};

type ParakeetRuntime = {
  readonly OfflineRecognizer: {
    readonly createAsync: (config: unknown) => Promise<ParakeetRecognizer>;
  };
  readonly LinearResampler: new (inputRate: number, outputRate: number) => ParakeetResampler;
  readonly writeWave: (
    path: string,
    input: { readonly samples: Float32Array; readonly sampleRate: number },
  ) => void;
};

/**
 * Runtime contract for node-cpal 0.1.1.
 *
 * The native module exposes one createStream function with an isInput flag.
 * Keep that low-level shape at this boundary so capture code remains stable.
 */
export type NativeMicrophoneStreamConfig = {
  readonly minSampleRate?: number;
  readonly maxSampleRate?: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly sampleFormat: "i16" | "u16" | "f32";
};

export type NativeMicrophoneDevice = {
  readonly name: string;
  readonly hostId: string;
  readonly deviceId: string;
  readonly isDefaultInput: boolean;
  readonly isDefaultOutput: boolean;
};

export type NativeMicrophoneHost = {
  readonly id: string;
  readonly name: string;
};

/** node-cpal's runtime returns the generated stream id directly. */
export type NativeMicrophoneStream = string;

export type NativeMicrophone = {
  readonly getHosts: () => ReadonlyArray<NativeMicrophoneHost>;
  readonly getDevices: (hostId?: string) => ReadonlyArray<NativeMicrophoneDevice>;
  readonly getDefaultInputDevice: () => NativeMicrophoneDevice;
  readonly getDefaultInputConfig: (deviceId: string) => NativeMicrophoneStreamConfig;
  readonly createStream: (
    deviceId: string,
    isInput: boolean,
    config: NativeMicrophoneStreamConfig,
    onData?: (data: Float32Array) => void,
  ) => NativeMicrophoneStream;
  readonly closeStream: (stream: NativeMicrophoneStream) => void;
};

type NativeSpeechProcess = {
  readonly killed: boolean;
  readonly kill: (signal?: string) => boolean;
  readonly once: (event: "error" | "exit", listener: (...args: Array<unknown>) => void) => void;
  readonly removeListener: (
    event: "error" | "exit",
    listener: (...args: Array<unknown>) => void,
  ) => void;
  readonly stderr: {
    readonly on: (event: "data", listener: (chunk: unknown) => void) => void;
    readonly removeListener: (event: "data", listener: (chunk: unknown) => void) => void;
  } | null;
};

export type NativeSpeechProcessDependencies = {
  readonly spawn: (command: string, args: ReadonlyArray<string>) => NativeSpeechProcess;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (timeout: unknown) => void;
};

function createNativeInputStream(
  microphone: NativeMicrophone,
  deviceId: string,
  config: NativeMicrophoneStreamConfig,
  onData: (data: Float32Array) => void,
): NativeMicrophoneStream {
  return microphone.createStream(deviceId, true, config, onData);
}

export type ParakeetCaptureDependencies = {
  readonly microphone: NativeMicrophone;
  readonly runtime: ParakeetRuntime;
};

export type ParakeetCaptureInput = {
  readonly paths: ParakeetModelPaths;
  /** Fires after the model and microphone are both ready. */
  readonly onReady?: () => void;
  /** Fires once when the input stream delivers its first non-empty frame. */
  readonly onFirstAudioFrame?: () => void;
  /** Throttled, normalized RMS level from the incoming PCM boundary. */
  readonly onAudioLevel?: (level: number) => void;
  readonly onTranscript?: (transcript: string) => void;
  readonly onMetrics?: (metrics: {
    readonly engineId: "parakeet-tdt-ctc-110m-int8";
    readonly readyLatencyMs?: number;
    readonly firstTranscriptLatencyMs?: number;
    readonly finalLatencyMs: number;
    readonly cpuTimeMs: number;
    readonly peakRssBytes: number;
    readonly resourceBytes: number;
  }) => void;
  /** Applies live Host vocabulary after Parakeet returns grounded text. */
  readonly transformTranscript?: (transcript: string) => string;
  /** Development-only directory where the exact 16 kHz input is retained. */
  readonly recordingDirectory?: string;
  readonly dependencies?: ParakeetCaptureDependencies;
  readonly platform?: string;
};

/** A Parakeet session fed by PCM owned by a renderer or another caller. */
export type ParakeetPcmCapture = ParakeetCapture & {
  readonly feed: (samples: Float32Array) => void;
};

export type ParakeetPcmCaptureInput = Omit<ParakeetCaptureInput, "dependencies" | "platform"> & {
  readonly sampleRate: number;
  readonly channels: number;
  readonly dependencies?: Pick<ParakeetCaptureDependencies, "runtime">;
  readonly platform?: string;
};

type ParakeetPcmCaptureCoreInput = Omit<ParakeetPcmCaptureInput, "sampleRate" | "channels">;

type ParakeetPcmCaptureSource = {
  readonly sampleRate: number;
  readonly channels: number;
  readonly start: (onData: (data: Float32Array) => void) => void;
  readonly close: () => void;
};

type ParakeetPcmCaptureSetup = {
  readonly source: ParakeetPcmCaptureSource;
  readonly dependencies: Pick<ParakeetCaptureDependencies, "runtime">;
  readonly checkResources: boolean;
};

const require = NodeModule.createRequire(import.meta.url);
let cachedParakeet:
  | { readonly key: string; readonly recognizer: Promise<ParakeetRecognizer> }
  | undefined;

const nativeMicrophoneContract = [
  "getDefaultInputDevice",
  "getDefaultInputConfig",
  "createStream",
  "closeStream",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Validates node-cpal's runtime API before it crosses the native boundary. */
export function validateNativeMicrophone(value: unknown): NativeMicrophone {
  if (!isRecord(value)) {
    throw new Error("Packaged node-cpal did not load an object.");
  }
  const missing = nativeMicrophoneContract.find((name) => typeof value[name] !== "function");
  if (missing !== undefined) {
    throw new Error(`Packaged node-cpal is missing required function ${missing}.`);
  }
  return value as unknown as NativeMicrophone;
}

function loadNativeMicrophone(): NativeMicrophone {
  return validateNativeMicrophone(require("node-cpal"));
}

export function isNativeSpeechPlatform(platform: string = process.platform): boolean {
  return platform === "darwin" || platform === "win32" || platform === "linux";
}

export function isNativeMicrophonePlatform(platform: string = process.platform): boolean {
  return platform === "win32" || platform === "linux";
}

/** Loads and validates the owned binding without enumerating or opening a physical device. */
export function prepareNativeMicrophone(platform = process.platform): void {
  if (!isNativeMicrophonePlatform(platform)) return;
  loadNativeMicrophone();
}

function nativeParakeetRuntime(): ParakeetRuntime {
  return require("sherpa-onnx-node") as ParakeetRuntime;
}

function nativeParakeetDependencies(): ParakeetCaptureDependencies {
  return {
    microphone: loadNativeMicrophone(),
    runtime: nativeParakeetRuntime(),
  };
}

function recognizerKey(paths: ParakeetModelPaths) {
  return [paths.encoderPath, paths.decoderPath, paths.joinerPath, paths.tokensPath].join("\n");
}

async function parakeetRecognizer(
  input: Pick<ParakeetCaptureInput, "paths">,
  runtime: ParakeetRuntime,
  cache = true,
  checkResources = true,
): Promise<ParakeetRecognizer> {
  const key = recognizerKey(input.paths);
  if (cache && cachedParakeet?.key === key) {
    return await cachedParakeet.recognizer;
  }
  const resourceError = parakeetResourceError(input.paths);
  if (resourceError !== undefined && checkResources) throw resourceError;
  const recognizer = runtime.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: input.paths.encoderPath,
        decoder: input.paths.decoderPath,
        joiner: input.paths.joinerPath,
      },
      tokens: input.paths.tokensPath,
      numThreads: 4,
      provider: "cpu",
      debug: false,
    },
  });
  if (cache) cachedParakeet = { key, recognizer };
  try {
    return await recognizer;
  } catch (cause) {
    if (cachedParakeet?.recognizer === recognizer) cachedParakeet = undefined;
    throw cause;
  }
}

export async function prepareParakeetRecognition(
  paths: ParakeetModelPaths,
  platform = process.platform,
): Promise<void> {
  if (!isNativeSpeechPlatform(platform)) return;
  await parakeetRecognizer({ paths }, nativeParakeetRuntime());
}

function concatenateSamples(chunks: ReadonlyArray<Float32Array>, length: number): Float32Array {
  const output = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function interleavedAudioToMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return samples;
  const frameCount = Math.floor(samples.length / channels);
  const mono = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let total = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      total += samples[frame * channels + channel] ?? 0;
    }
    mono[frame] = total / channels;
  }
  return mono;
}

/** Returns a bounded RMS level suitable for a low-rate listening indicator. */
export function normalizedAudioRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) total += sample * sample;
  return Math.min(1, Math.sqrt(total / samples.length));
}

export const parakeetSampleRate = 16_000;
const AUDIO_LEVEL_INTERVAL_MS = 90;
function startParakeetPcmCaptureInternal(
  input: ParakeetPcmCaptureCoreInput,
  setupPromise: ParakeetPcmCaptureSetup | Promise<ParakeetPcmCaptureSetup>,
): ParakeetPcmCapture {
  if (!isNativeSpeechPlatform(input.platform ?? process.platform)) {
    throw new Error("Local Parakeet recognition is unavailable on this platform.");
  }
  let settled = false;
  let released = false;
  let finalizing = false;
  let finalizeRequested = false;
  let source: ParakeetPcmCaptureSource | undefined;
  let sourceClosed = false;
  let resampler: ParakeetResampler | undefined;
  let dependencies: Pick<ParakeetCaptureDependencies, "runtime"> | undefined;
  let recognizerPromise: Promise<ParakeetRecognizer> | undefined;
  const chunks: Array<Float32Array> = [];
  let sampleCount = 0;
  const startedAt = performance.now();
  const startedCpu = process.cpuUsage();
  let peakRssBytes = process.memoryUsage().rss;
  let readyAt: number | undefined;
  let firstTranscriptAt: number | undefined;
  let receivedAudioFrame = false;
  let lastAudioLevelAt = Number.NEGATIVE_INFINITY;
  const lifetimeAbort = new AbortController();
  let resolveResult: (transcript: string) => void;
  let rejectResult: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const closeSource = () => {
    if (source === undefined || sourceClosed) return;
    sourceClosed = true;
    source.close();
  };
  const observeRss = () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  };
  const finish = (value: string | Error) => {
    if (settled) return;
    settled = true;
    lifetimeAbort.abort();
    closeSource();
    observeRss();
    const cpu = process.cpuUsage(startedCpu);
    const resourceBytes = [
      input.paths.encoderPath,
      input.paths.decoderPath,
      input.paths.joinerPath,
      input.paths.tokensPath,
    ].reduce((total, path) => {
      try {
        return total + NodeFS.statSync(path).size;
      } catch {
        return total;
      }
    }, 0);
    try {
      input.onMetrics?.({
        engineId: "parakeet-tdt-ctc-110m-int8",
        ...(readyAt === undefined ? {} : { readyLatencyMs: readyAt - startedAt }),
        ...(firstTranscriptAt === undefined
          ? {}
          : { firstTranscriptLatencyMs: firstTranscriptAt - startedAt }),
        finalLatencyMs: performance.now() - startedAt,
        cpuTimeMs: (cpu.user + cpu.system) / 1_000,
        peakRssBytes,
        resourceBytes,
      });
    } catch {
      // Development metrics are observational and cannot change capture completion.
    }
    if (value instanceof Error) rejectResult(value);
    else resolveResult(value);
  };

  const finalize = async () => {
    if (settled || finalizing) return;
    if (source === undefined || resampler === undefined) {
      finalizeRequested = true;
      return;
    }
    finalizing = true;
    closeSource();
    const tail = resampler.flush(new Float32Array());
    if (tail.length > 0) {
      chunks.push(tail);
      sampleCount += tail.length;
    }
    const samples = concatenateSamples(chunks, sampleCount);
    try {
      const activeDependencies = dependencies ?? {
        runtime: nativeParakeetRuntime(),
      };
      if (input.recordingDirectory !== undefined) {
        activeDependencies.runtime.writeWave(
          NodePath.join(input.recordingDirectory, "capture.wav"),
          {
            samples,
            sampleRate: parakeetSampleRate,
          },
        );
      }
      if (samples.length === 0) {
        finish(
          createVoiceCaptureError(
            "no-audio-frames",
            "I didn't hear a complete instruction. Try again.",
          ),
        );
        return;
      }
      const recognizer = await (recognizerPromise ??
        parakeetRecognizer(
          input,
          activeDependencies.runtime,
          input.dependencies === undefined,
          input.dependencies === undefined,
        ));
      const recognitionStream = recognizer.createStream();
      recognitionStream.acceptWaveform({ samples, sampleRate: parakeetSampleRate });
      const decoded = await recognizer.decodeAsync(recognitionStream);
      const rawTranscript = decoded.text?.replace(/\s+/gu, " ").trim() ?? "";
      if (rawTranscript.length === 0) {
        finish(
          createVoiceCaptureError(
            "transcription-failed",
            "I didn't hear a complete instruction. Try again.",
          ),
        );
        return;
      }
      firstTranscriptAt = performance.now();
      let transcript = rawTranscript;
      try {
        transcript = input.transformTranscript?.(rawTranscript) ?? rawTranscript;
      } catch {
        // Vocabulary repair is advisory; never discard valid Parakeet output.
      }
      try {
        input.onTranscript?.(transcript);
      } catch {
        // Rendering the final transcript cannot invalidate recognition.
      }
      finish(transcript);
    } catch (cause) {
      const error =
        cause instanceof Error ? cause : new Error("Local Parakeet recognition failed.");
      finish(createVoiceCaptureError(classifyVoiceCaptureError(error), error.message, error));
    }
  };

  const release = () => {
    if (settled || released) return;
    released = true;
    void finalize();
  };

  const feed = (data: Float32Array): void => {
    if (settled || released || resampler === undefined || source === undefined) return;
    if (data.length === 0) return;
    const now = performance.now();
    if (now - lastAudioLevelAt >= AUDIO_LEVEL_INTERVAL_MS) {
      lastAudioLevelAt = now;
      try {
        input.onAudioLevel?.(normalizedAudioRms(data));
      } catch {
        // A presentation callback cannot stop the capture.
      }
    }
    if (!receivedAudioFrame) {
      receivedAudioFrame = true;
      try {
        input.onFirstAudioFrame?.();
      } catch {
        // A presentation callback cannot stop the capture.
      }
    }
    const samples = resampler.resample(interleavedAudioToMono(data, source.channels));
    if (samples.length === 0) return;
    chunks.push(samples.slice());
    sampleCount += samples.length;
  };

  const initialize = (setup: ParakeetPcmCaptureSetup): void => {
    try {
      source = setup.source;
      dependencies = setup.dependencies;
      if (settled) {
        closeSource();
        return;
      }
      if (released) {
        finish(
          createVoiceCaptureError(
            "cancelled",
            "Voice capture stopped before the microphone was ready.",
          ),
        );
        return;
      }
      resampler = new setup.dependencies.runtime.LinearResampler(
        setup.source.sampleRate,
        parakeetSampleRate,
      );
      recognizerPromise = parakeetRecognizer(
        input,
        setup.dependencies.runtime,
        setup.checkResources,
        setup.checkResources,
      );
      void recognizerPromise.catch((cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error("Local Parakeet could not start.");
        finish(createVoiceCaptureError(classifyVoiceCaptureError(error), error.message, error));
      });
      setup.source.start((data) => {
        if (settled || released) return;
        feed(data);
      });
      readyAt = performance.now();
      observeRss();
      try {
        input.onReady?.();
      } catch {
        // A presentation callback cannot stop the capture.
      }
      if (finalizeRequested) void finalize();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error("Local Parakeet could not start.");
      finish(createVoiceCaptureError(classifyVoiceCaptureError(error), error.message, error));
    }
  };

  if (setupPromise instanceof Promise) {
    void setupPromise.then(initialize, (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error("Local Parakeet could not start.");
      finish(createVoiceCaptureError(classifyVoiceCaptureError(error), error.message, error));
    });
  } else {
    initialize(setupPromise);
  }

  let capture: ParakeetPcmCapture;
  capture = {
    result,
    release,
    cancel: () => finish(createVoiceCaptureError("cancelled", "Voice capture cancelled.")),
    feed,
  };

  return capture;
}

function startParakeetCaptureInternal(input: ParakeetCaptureInput): ParakeetCapture {
  if (!isNativeMicrophonePlatform(input.platform ?? process.platform)) {
    throw new Error("Native Parakeet microphone capture is available on Windows and Linux only.");
  }

  const { dependencies: injectedDependencies, ...captureInput } = input;
  let stream: NativeMicrophoneStream | undefined;
  const activeDependencies = injectedDependencies ?? nativeParakeetDependencies();
  const microphone = activeDependencies.microphone;
  const device = microphone.getDefaultInputDevice();
  const deviceConfig = microphone.getDefaultInputConfig(device.deviceId);
  const setupPromise: ParakeetPcmCaptureSetup = {
    dependencies: { runtime: activeDependencies.runtime },
    checkResources: injectedDependencies === undefined,
    source: {
      sampleRate: deviceConfig.sampleRate,
      channels: deviceConfig.channels,
      start: (onData) => {
        stream = createNativeInputStream(
          microphone,
          device.deviceId,
          {
            sampleRate: deviceConfig.sampleRate,
            channels: deviceConfig.channels,
            sampleFormat: deviceConfig.sampleFormat,
          },
          onData,
        );
      },
      close: () => {
        if (stream === undefined) return;
        microphone.closeStream(stream);
        stream = undefined;
      },
    },
  };

  return startParakeetPcmCaptureInternal(captureInput, setupPromise);
}

/** Captures one explicit push-to-talk utterance and decodes it with Parakeet on release. */
export function startParakeetCapture(input: ParakeetCaptureInput): ParakeetCapture {
  const capture = startParakeetCaptureInternal(input);
  return {
    result: capture.result,
    release: capture.release,
    cancel: capture.cancel,
  };
}

/** Captures externally supplied PCM and decodes it with the same Parakeet lifecycle. */
export function startParakeetPcmCapture(input: ParakeetPcmCaptureInput): ParakeetPcmCapture {
  const setup: ParakeetPcmCaptureSetup = {
    source: {
      sampleRate: input.sampleRate,
      channels: input.channels,
      start: () => undefined,
      close: () => undefined,
    },
    dependencies: input.dependencies ?? { runtime: nativeParakeetRuntime() },
    checkResources: input.dependencies === undefined,
  };
  return startParakeetPcmCaptureInternal(input, setup);
}

export function speakNativeSpeech(text: string, platform = process.platform): Promise<void> {
  if (!isNativeSpeechPlatform(platform) || text.trim().length === 0) return Promise.resolve();
  return pocketSpeechQueue.enqueue(text);
}

/** Reserves acknowledgement order before a local voice task crosses the network. */
export function reserveNativeSpeech(platform = process.platform): SpeechReservation {
  if (!isNativeSpeechPlatform(platform)) {
    return { commit: () => Promise.resolve(), cancel: () => undefined };
  }
  return pocketSpeechQueue.reserve();
}

/** Whether acknowledgement speech can begin without another worker cold start. */
export function isNativeSpeechReady(platform = process.platform): boolean {
  if (!isNativeSpeechPlatform(platform)) return false;
  const state = pocketLifecycle.state();
  return state === "ready" || state === "synthesizing";
}

/** Warms Pocket only after this device has won the Host speaker claim. */
export async function prepareNativeSpeech(platform = process.platform): Promise<void> {
  if (!isNativeSpeechPlatform(platform)) return;
  await pocketLifecycle.prewarm();
}

/** Stops current Pocket playback, discards queued speech, and releases model memory. */
export function interruptNativeSpeech(): void {
  pocketSpeechQueue.interrupt();
  pocketLifecycle.interrupt();
}

export function isNativeSpeechActive(): boolean {
  return pocketSpeechQueue.isActive();
}

export async function disposeNativeSpeech(): Promise<void> {
  pocketSpeechQueue.interrupt();
  await pocketLifecycle.dispose();
}

const nativeSpeechStderrLimit = 4_096;

const defaultNativeSpeechProcessDependencies: NativeSpeechProcessDependencies = {
  spawn: (command, args) =>
    NodeChildProcess.spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    }) as unknown as NativeSpeechProcess,
  setTimeout: (callback, delayMs) => NodeTimers.setTimeout(callback, delayMs),
  clearTimeout: (timeout) => NodeTimers.clearTimeout(timeout as NodeJS.Timeout),
};

type NativeSpeechPlayer = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

type NativeSpeechAttemptResult =
  | { readonly kind: "success" }
  | { readonly kind: "aborted" }
  | { readonly kind: "timeout" }
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string };

const linuxNativeSpeechPlayers = (path: string): ReadonlyArray<NativeSpeechPlayer> => [
  { command: "pw-play", args: [path] },
  { command: "paplay", args: [path] },
  { command: "aplay", args: ["-q", path] },
];

function nativeSpeechErrorCode(cause: unknown): string | undefined {
  if (!isRecord(cause) || typeof cause.code !== "string") return undefined;
  return cause.code;
}

function boundedNativeSpeechStderr(stream: NativeSpeechProcess["stderr"]): {
  readonly read: () => string;
  readonly onData: (chunk: unknown) => void;
} {
  let output = "";
  const onData = (chunk: unknown) => {
    if (output.length >= nativeSpeechStderrLimit) return;
    const text = typeof chunk === "string" ? chunk : String(chunk);
    output += text.slice(0, nativeSpeechStderrLimit - output.length);
  };
  stream?.on("data", onData);
  return { read: () => output.trim(), onData };
}

function terminateNativeSpeechProcess(child: NativeSpeechProcess): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
    if (child.killed) finish();
    else {
      try {
        child.kill("SIGKILL");
      } catch {
        finish();
      }
    }
  });
}

async function runNativeSpeechAttempt(
  player: NativeSpeechPlayer,
  signal: AbortSignal | undefined,
  dependencies: NativeSpeechProcessDependencies,
  timeoutMs: number,
): Promise<NativeSpeechAttemptResult> {
  if (signal?.aborted) return { kind: "aborted" };
  let child: NativeSpeechProcess;
  try {
    child = dependencies.spawn(player.command, player.args);
  } catch (cause) {
    if (nativeSpeechErrorCode(cause) === "ENOENT") {
      return { kind: "unavailable", detail: `${player.command} is not installed.` };
    }
    return {
      kind: "failed",
      detail: `${player.command} could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const stderr = boundedNativeSpeechStderr(child.stderr);
  return await new Promise<NativeSpeechAttemptResult>((resolve) => {
    let settled = false;
    let terminationReason: "aborted" | "timeout" | undefined;
    let timeoutHandle: unknown;
    const onExit = (...args: Array<unknown>) => {
      if (terminationReason !== undefined) {
        finish({ kind: terminationReason });
        return;
      }
      if (args[0] === 0) {
        finish({ kind: "success" });
        return;
      }
      const code = args[0] === null || args[0] === undefined ? "unknown" : String(args[0]);
      finish({
        kind: "failed",
        detail: `${player.command} exited with ${code}${stderr.read() ? `: ${stderr.read()}` : "."}`,
      });
    };
    const onError = (cause: unknown) => {
      if (terminationReason !== undefined) {
        finish({ kind: terminationReason });
        return;
      }
      if (nativeSpeechErrorCode(cause) === "ENOENT") {
        finish({ kind: "unavailable", detail: `${player.command} is not installed.` });
        return;
      }
      finish({
        kind: "failed",
        detail: `${player.command} could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    };
    const cleanup = () => {
      if (timeoutHandle !== undefined) dependencies.clearTimeout?.(timeoutHandle);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      child.stderr?.removeListener("data", stderr.onData);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: NativeSpeechAttemptResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => {
      if (settled || terminationReason !== undefined) return;
      terminationReason = "aborted";
      void terminateNativeSpeechProcess(child).then(() => finish({ kind: "aborted" }));
    };
    child.once("exit", onExit);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    timeoutHandle = dependencies.setTimeout?.(() => {
      if (settled || terminationReason !== undefined) return;
      terminationReason = "timeout";
      void terminateNativeSpeechProcess(child).then(() => finish({ kind: "timeout" }));
    }, timeoutMs);
    if (signal?.aborted) onAbort();
  });
}

export async function playNativeCue(
  path: string,
  platform = process.platform,
  signal?: AbortSignal,
  dependencies: NativeSpeechProcessDependencies = defaultNativeSpeechProcessDependencies,
): Promise<void> {
  if (platform === "win32") {
    if (signal?.aborted) return;
    const escapedPath = path.replaceAll("'", "''");
    await new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$cue = New-Object System.Media.SoundPlayer '${escapedPath}'; $cue.PlaySync()`,
        ],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
      );
      let settled = false;
      const timeoutAbort = new AbortController();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        timeoutAbort.abort();
        signal?.removeEventListener("abort", onAbort);
        if (error !== undefined) {
          if (!child.killed) child.kill();
          reject(error);
          return;
        }
        resolve();
      };
      const onAbort = () => {
        if (!child.killed) child.kill();
        finish();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void NodeTimersPromises.setTimeout(nativeAudioPlaybackTimeoutMs, undefined, {
        signal: timeoutAbort.signal,
      })
        .then(() => finish(new Error("Jarvis voice playback took too long.")))
        .catch(() => undefined);
      child.once("error", (error) => finish(error));
      child.once("exit", (code, exitSignal) => {
        if (signal?.aborted) {
          finish();
          return;
        }
        if (code === 0) {
          finish();
          return;
        }
        finish(
          new Error(
            exitSignal === null
              ? `Jarvis voice playback stopped (exit ${code ?? "unknown"}).`
              : `Jarvis voice playback stopped (${exitSignal}).`,
          ),
        );
      });
    });
    return;
  }
  if (platform === "linux") {
    const failures: Array<string> = [];
    for (const player of linuxNativeSpeechPlayers(path)) {
      const result = await runNativeSpeechAttempt(
        player,
        signal,
        dependencies,
        nativeAudioPlaybackTimeoutMs,
      );
      if (result.kind === "success" || result.kind === "aborted") return;
      if (result.kind === "timeout") {
        throw new Error("Jarvis voice playback took too long.");
      }
      failures.push(`${player.command}: ${result.detail}`);
    }
    throw new Error(
      `Jarvis voice playback failed: no supported Linux audio player succeeded. ${failures.join(" ")}`,
    );
  }
  if (platform === "darwin") {
    const result = await runNativeSpeechAttempt(
      { command: "/usr/bin/afplay", args: [path] },
      signal,
      dependencies,
      nativeAudioPlaybackTimeoutMs,
    );
    if (result.kind === "success" || result.kind === "aborted") return;
    if (result.kind === "timeout") throw new Error("Jarvis voice playback took too long.");
    throw new Error(`Jarvis voice playback failed: afplay ${result.detail}`);
  }
}

export const nativeAudioPlaybackTimeoutMs = 120_000;
