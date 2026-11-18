import {
  captureDeviceScreenshot,
  DeviceScreenshotError,
} from "@t3tools/client-runtime/device/screenshot";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { type DeviceHubTarget, fetchDeviceAxTree } from "./deviceHubApi";
import {
  type DeviceInput,
  type DeviceRecordingCapture,
  pickKeyframes,
  type TimedDeviceInput,
} from "./deviceRecording.logic";
import type { DeviceAxElement } from "./deviceHubApi";

const isDeviceScreenshotError = Schema.is(DeviceScreenshotError);

/** How long input must stay quiet after a step before its frame is taken. */
const SETTLE_MS = 600;
// The stream repaints even when idle, so quiet video cannot say a launch or load finished.
// A second look replaces the first when the user keeps waiting.
const SETTLED_AGAIN_MS = 2_500;
// Bounds memory on long sessions; the handoff picks its frames from these.
const MAX_HELD_FRAMES = 36;
const THINNED_FRAMES = 24;
const VIDEO_BITS_PER_SECOND = 2_000_000;
// Leaves room under the attachment limit for the final chunk the recorder flushes on stop.
const VIDEO_MAX_BYTES = PROVIDER_SEND_TURN_MAX_FILE_BYTES - 2 * 1024 * 1024;
const VIDEO_MIME_TYPES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4",
] as const;

export interface DeviceRecorderCapture extends DeviceRecordingCapture {
  readonly frame: Blob | null;
}

export interface DeviceRecorderVideo {
  readonly blob: Blob;
  readonly mimeType: string;
  /** The video hit the attachment size limit and ended before the recording did. */
  readonly truncated: boolean;
}

export interface DeviceRecorderResult {
  readonly durationMs: number;
  readonly inputs: ReadonlyArray<TimedDeviceInput>;
  readonly captures: ReadonlyArray<DeviceRecorderCapture>;
  readonly video: DeviceRecorderVideo | null;
}

export interface DeviceRecorder {
  readonly record: (input: DeviceInput) => void;
  readonly stop: () => Promise<DeviceRecorderResult>;
}

/**
 * Collects input and takes a screenshot plus accessibility tree at the start and
 * after each step settles. Interpreting them waits for `buildDeviceRecording`.
 */
export function startDeviceRecorder(options: {
  readonly target: DeviceHubTarget;
  /** A fresh hub ticket after a 401, or null when none can be had. */
  readonly renewAccess: () => Promise<DeviceHubTarget["access"] | null>;
  /** The stream's canvas, or null when the stream has none to record (MJPEG). */
  readonly videoSource: HTMLCanvasElement | null;
}): DeviceRecorder {
  const startedAt = performance.now();
  const now = () => performance.now() - startedAt;
  const signal = new AbortController().signal;
  let target = options.target;
  const inputs: TimedDeviceInput[] = [];
  const captures: DeviceRecorderCapture[] = [];
  let touching = false;
  let settleTimers: Array<ReturnType<typeof setTimeout>> = [];
  let inFlight: Promise<void> | null = null;
  let captureQueued = false;
  let stopped = false;
  const video = options.videoSource ? startCanvasVideo(options.videoSource) : null;

  const withRenewal = async <A>(request: () => Promise<A>): Promise<A> => {
    try {
      return await request();
    } catch (cause) {
      if (!isDeviceScreenshotError(cause) || cause.status !== 401) throw cause;
      const access = await options.renewAccess();
      if (!access) throw cause;
      target = { ...target, access };
      return request();
    }
  };

  const thinFrames = () => {
    const held = captures.flatMap((capture, index) => (capture.frame ? [index] : []));
    if (held.length <= MAX_HELD_FRAMES) return;
    const kept = pickKeyframes(held, THINNED_FRAMES);
    for (const index of held) {
      if (!kept.has(index)) captures[index] = { ...captures[index]!, frame: null, hasFrame: false };
    }
  };

  const capture = (): Promise<void> => {
    if (inFlight) {
      captureQueued = true;
      return inFlight;
    }
    const requestedAt = now();
    inFlight = Promise.allSettled([
      withRenewal(() => captureDeviceScreenshot(target, signal)),
      fetchDeviceAxTree(target, signal),
    ]).then(([frame, tree]) => {
      inFlight = null;
      const elements: ReadonlyArray<DeviceAxElement> | null =
        tree.status === "fulfilled" && tree.value.errors.length === 0 ? tree.value.elements : null;
      const blob = frame.status === "fulfilled" ? frame.value : null;
      captures.push({ requestedAt, frame: blob, hasFrame: blob !== null, elements });
      thinFrames();
      if (captureQueued && !stopped) {
        captureQueued = false;
        return capture();
      }
    });
    return inFlight;
  };

  const clearSettle = () => {
    for (const timer of settleTimers) clearTimeout(timer);
    settleTimers = [];
  };

  const settle = () => {
    clearSettle();
    if (touching || stopped) return;
    settleTimers = [SETTLE_MS, SETTLED_AGAIN_MS].map((delay) =>
      setTimeout(() => void capture(), delay),
    );
  };

  void capture();

  return {
    record: (input) => {
      if (stopped) return;
      inputs.push({ at: now(), input });
      if (input.type === "touch") {
        if (input.phase === "move") return;
        touching = input.phase === "begin";
      }
      settle();
    },
    stop: async () => {
      stopped = true;
      captureQueued = false;
      clearSettle();
      const durationMs = now();
      const videoResult = video ? video.stop() : Promise.resolve(null);
      await inFlight;
      const lastInput = inputs.at(-1)?.at ?? Number.NEGATIVE_INFINITY;
      const lastCapture = captures.at(-1)?.requestedAt ?? Number.NEGATIVE_INFINITY;
      if (lastInput >= lastCapture) await capture();
      return { durationMs, inputs, captures, video: await videoResult };
    },
  };
}

/** Records the stream canvas in the browser, so it works the same for every device host. */
function startCanvasVideo(
  canvas: HTMLCanvasElement,
): { readonly stop: () => Promise<DeviceRecorderVideo | null> } | null {
  if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") {
    return null;
  }
  const mimeType = VIDEO_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) return null;
  let stream: MediaStream;
  let recorder: MediaRecorder;
  try {
    stream = canvas.captureStream(30);
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    });
  } catch {
    return null;
  }
  const chunks: Blob[] = [];
  let bytes = 0;
  let truncated = false;
  let failed = false;
  const finished = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size === 0) return;
    chunks.push(event.data);
    bytes += event.data.size;
    if (bytes >= VIDEO_MAX_BYTES && recorder.state === "recording") {
      truncated = true;
      recorder.stop();
    }
  });
  recorder.addEventListener("error", () => {
    failed = true;
  });
  // Chunks arrive every second, so the size limit is checked while recording.
  recorder.start(1_000);
  return {
    stop: async () => {
      if (recorder.state !== "inactive") recorder.stop();
      await finished;
      for (const track of stream.getTracks()) track.stop();
      if (failed || bytes === 0) return null;
      const type = mimeType.split(";", 1)[0]!;
      const blob = new Blob(chunks, { type });
      if (blob.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) return null;
      return { blob, mimeType: type, truncated };
    },
  };
}
