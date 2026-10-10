import { DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER } from "@t3tools/contracts";
import type {
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";
import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { randomUUID } from "~/lib/utils";

import { createRecordingCompositor } from "./recordingCompositor";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";

export class BrowserRecordingUnavailableError extends Schema.TaggedError<BrowserRecordingUnavailableError>()(
  "BrowserRecordingUnavailableError",
  {
    tabId: Schema.String,
  },
) {
  override get message(): string {
    return `Browser recording is unavailable for tab ${this.tabId}.`;
  }
}

export class BrowserRecordingConflictError extends Schema.TaggedError<BrowserRecordingConflictError>()(
  "BrowserRecordingConflictError",
  {
    requestedTabId: Schema.String,
    activeTabId: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot record tab ${this.requestedTabId} while tab ${this.activeTabId} is already being recorded.`;
  }
}

export class BrowserRecordingStartCancelledError extends Schema.TaggedError<BrowserRecordingStartCancelledError>()(
  "BrowserRecordingStartCancelledError",
  {
    tabId: Schema.String,
  },
) {
  override get message(): string {
    return `Browser recording start was cancelled for tab ${this.tabId}.`;
  }
}

export class BrowserRecordingFormatUnavailableError extends Schema.TaggedError<BrowserRecordingFormatUnavailableError>()(
  "BrowserRecordingFormatUnavailableError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `MediaRecorder did not report an output format for tab ${this.tabId}.`;
  }
}

export class BrowserRecordingCaptureTimeoutError extends Schema.TaggedError<BrowserRecordingCaptureTimeoutError>()(
  "BrowserRecordingCaptureTimeoutError",
  {
    tabId: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Browser recording media capture for tab ${this.tabId} did not settle within ${this.timeoutMs}ms.`;
  }
}

export class BrowserRecordingOperationError extends Schema.TaggedError<BrowserRecordingOperationError>()(
  "BrowserRecordingOperationError",
  {
    operation: Schema.Literals([
      "initialize-media-recorder",
      "capture-media-stream",
      "start-media-recorder",
      "start-screencast",
      "stop-screencast",
      "wait-startup",
      "stop-media-recorder",
      "save-artifact",
      "cleanup",
    ]),
    tabId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Browser recording operation ${this.operation} failed for tab ${this.tabId}.`;
  }
}

const isBrowserRecordingOperationError = Schema.is(BrowserRecordingOperationError);
const isBrowserRecordingCaptureTimeoutError = Schema.is(BrowserRecordingCaptureTimeoutError);
export const isBrowserRecordingStartCancelledError = Schema.is(BrowserRecordingStartCancelledError);

interface StartingBrowserRecordingLifecycle {
  readonly phase: "starting";
}

type BrowserRecordingLifecycle =
  | StartingBrowserRecordingLifecycle
  | { readonly phase: "recording" }
  | {
      readonly phase: "stopping";
      readonly stopPromise: Promise<DesktopPreviewRecordingArtifact | null>;
    };

interface ActiveRecording {
  /** Desktop-scoped identity used by the native capture lease. */
  readonly tabId: string;
  /** Server-local identity returned by preview automation tools. */
  readonly serverTabId: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly chunks: Blob[];
  readonly startedAt: string;
  readonly startupSettled: Promise<void>;
  releaseSurfaceActivity: (() => void) | null;
  releaseCapture: (() => void) | null;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  compositor: Awaited<ReturnType<typeof createRecordingCompositor>>;
  savedBlob?: Blob;
  uploadPromise?: Promise<string>;
  lifecycle: BrowserRecordingLifecycle;
}

export interface ActiveBrowserRecordingTarget {
  readonly runtimeTabId: string;
  readonly serverTabId: string;
}

interface ActiveBrowserRecordingIndex {
  readonly tabIds: ReadonlySet<string>;
}

const activeBrowserRecordingTabIdsAtom = Atom.make<ActiveBrowserRecordingIndex>({
  tabIds: new Set<string>(),
}).pipe(Atom.keepAlive, Atom.withLabel("preview:active-browser-recording-tabs"));

export function useActiveBrowserRecordingTabIds(): ReadonlySet<string> {
  return useAtomValue(activeBrowserRecordingTabIdsAtom).tabIds;
}

const activeRecordings = new Map<string, ActiveRecording>();

const publishActiveRecordingTabIds = (): void => {
  appAtomRegistry.set(activeBrowserRecordingTabIdsAtom, {
    tabIds: new Set(activeRecordings.keys()),
  });
};

export const BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS = 5_000;
export const BROWSER_RECORDING_PAINT_SETTLE_TIMEOUT_MS = 250;

export function readActiveBrowserRecordingTabIds(threadRef?: ScopedThreadRef): ReadonlySet<string> {
  const tabIds = new Set<string>();
  for (const recording of activeRecordings.values()) {
    if (
      threadRef === undefined ||
      (recording.threadRef?.environmentId === threadRef.environmentId &&
        recording.threadRef.threadId === threadRef.threadId)
    ) {
      tabIds.add(recording.tabId);
    }
  }
  return tabIds;
}

export function readActiveBrowserRecordingTargets(
  threadRef: ScopedThreadRef,
): ReadonlyArray<ActiveBrowserRecordingTarget> {
  return Array.from(activeRecordings.values()).flatMap((recording) =>
    recording.threadRef?.environmentId === threadRef.environmentId &&
    recording.threadRef.threadId === threadRef.threadId
      ? [{ runtimeTabId: recording.tabId, serverTabId: recording.serverTabId }]
      : [],
  );
}

export function findActiveBrowserRecordingRuntimeTabId(
  threadRef: ScopedThreadRef,
  serverTabId: string,
): string | null {
  return (
    readActiveBrowserRecordingTargets(threadRef).find(
      (recording) => recording.serverTabId === serverTabId,
    )?.runtimeTabId ?? null
  );
}

const preferredMimeTypes = [
  "video/mp4;codecs=avc1",
  "video/mp4;codecs=avc1.640028",
  "video/mp4;codecs=avc1.42e01e",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

const createMediaRecorder = (stream: MediaStream): MediaRecorder => {
  const mimeType = preferredMimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  const settings = stream.getVideoTracks()[0]?.getSettings();
  // Browser defaults under-budget native-resolution text and motion. Scale with captured pixels
  // and frames, while bounding storage and encoder load for very large displays.
  const videoBitsPerSecond = Math.round(
    Math.min(
      50_000_000,
      Math.max(
        2_500_000,
        (settings?.width ?? 1920) * (settings?.height ?? 1080) * (settings?.frameRate || 30) * 0.05,
      ),
    ),
  );
  return new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond });
};

interface RecordingCaptureSize {
  readonly width: number;
  readonly height: number;
}

const captureTabMediaStream = (
  sourceId: string,
  frameRate: number,
  size: RecordingCaptureSize,
): Promise<MediaStream> =>
  // Capture the existing guest tab without selecting an OS display source.
  navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: sourceId,
        minWidth: size.width,
        maxWidth: size.width,
        minHeight: size.height,
        maxHeight: size.height,
        maxFrameRate: frameRate,
      },
    } as MediaTrackConstraints,
  });

const stopMediaRecorder = async (recorder: MediaRecorder | null): Promise<void> => {
  if (!recorder || recorder.state === "inactive") return;
  const stopped = new Promise<void>((resolve) =>
    recorder.addEventListener("stop", () => resolve(), { once: true }),
  );
  recorder.stop();
  await stopped;
};

const stopMediaStream = (stream: MediaStream | null): void => {
  for (const track of stream?.getTracks() ?? []) track.stop();
};

interface PageFrameCaptureRequest {
  readonly mode: "frame-subscription";
  readonly captureId: string;
}

interface PendingTabMediaCapture {
  readonly start: (
    sourceId: string,
    size: RecordingCaptureSize,
  ) => Promise<true | PageFrameCaptureRequest>;
}

const pendingTabMediaCaptures = new Map<string, PendingTabMediaCapture>();
const pageFrameCaptures = new Map<
  string,
  {
    readonly captureId: string;
    readonly receive: (
      frame: DesktopPreviewRecordingFrame,
      sourceVersion?: number,
    ) => Promise<boolean>;
    readonly replaceSource: (sourceVersion: number) => boolean;
    readonly end: () => void;
  }
>();

const captureRecordingPageFrames = (tabId: string, frameRate: number) => {
  let accepting = true;
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let stream: MediaStream | null = null;
  let delivered = false;
  const captureId = randomUUID();
  let sourceVersion = 0;
  let pendingFrame: {
    readonly frame: DesktopPreviewRecordingFrame;
    readonly sourceVersion: number;
  } | null = null;
  let consumption: Promise<boolean> | null = null;
  let releaseFrameDelay: (() => void) | undefined;
  let frameDelay: ReturnType<typeof setTimeout> | undefined;
  let lastFrameAt = -Infinity;
  let resolveCapture!: (stream: MediaStream) => void;
  let rejectCapture!: (cause: unknown) => void;
  const streamPromise = new Promise<MediaStream>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  const dispose = (cause: unknown = new BrowserRecordingStartCancelledError({ tabId })) => {
    if (!accepting) return;
    accepting = false;
    pendingFrame = null;
    clearTimeout(frameDelay);
    releaseFrameDelay?.();
    if (pageFrameCaptures.get(tabId)?.captureId === captureId) pageFrameCaptures.delete(tabId);
    if (!delivered) stopMediaStream(stream);
    rejectCapture(cause);
    canvas = null;
    context = null;
    stream = null;
  };
  const receive = (
    frame: DesktopPreviewRecordingFrame,
    version = sourceVersion,
  ): Promise<boolean> => {
    if (
      !accepting ||
      version !== sourceVersion ||
      frame.tabId !== tabId ||
      !Number.isInteger(frame.width) ||
      frame.width <= 0 ||
      !Number.isInteger(frame.height) ||
      frame.height <= 0
    )
      return Promise.resolve(false);
    // Keep the final page update even if it arrives during decoding or throttling.
    pendingFrame = { frame, sourceVersion: version };
    if (consumption) return consumption;
    consumption = (async () => {
      while (pendingFrame) {
        if (!accepting) break;
        const delay = 1000 / frameRate - (performance.now() - lastFrameAt);
        if (delay > 1) {
          await new Promise<void>((resolve) => {
            releaseFrameDelay = resolve;
            frameDelay = setTimeout(resolve, delay);
          });
          releaseFrameDelay = undefined;
          frameDelay = undefined;
        }
        if (!accepting || !pendingFrame) break;
        const { frame: current, sourceVersion: decodingVersion } = pendingFrame;
        pendingFrame = null;
        lastFrameAt = performance.now();
        let bitmap: ImageBitmap | undefined;
        try {
          const binary = atob(current.data);
          const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
          bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
          if (!accepting) break;
          if (decodingVersion !== sourceVersion) continue;
          if (!canvas) {
            canvas = document.createElement("canvas");
            context = canvas.getContext("2d", { alpha: false });
            if (!context) throw new Error("Recording canvas is unavailable.");
          }
          if (canvas.width !== current.width) canvas.width = current.width;
          if (canvas.height !== current.height) canvas.height = current.height;
          context!.drawImage(bitmap, 0, 0, current.width, current.height);
          const firstFrame = stream === null;
          stream ??= canvas.captureStream(0);
          (stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack).requestFrame();
          if (firstFrame) {
            delivered = true;
            resolveCapture(stream);
          }
        } catch (error) {
          if (accepting && decodingVersion === sourceVersion && !delivered) {
            // Rejecting startup is terminal, even while native cleanup is pending.
            dispose(error);
          }
        } finally {
          bitmap?.close();
        }
      }
      return accepting;
    })().finally(() => {
      consumption = null;
    });
    return consumption;
  };
  pageFrameCaptures.set(tabId, {
    captureId,
    receive,
    replaceSource: (version) => {
      if (!accepting || !Number.isInteger(version) || version < sourceVersion) return false;
      if (version !== sourceVersion) pendingFrame = null;
      sourceVersion = version;
      return true;
    },
    end: () => {
      dispose();
      void stopBrowserRecording(tabId).catch(() => undefined);
    },
  });
  return {
    captureId,
    streamPromise,
    dispose,
  };
};

const prepareTabMediaCapture = (tabId: string, frameRate: number) => {
  let acceptStream = true;
  let capturedStream: MediaStream | null = null;
  let pageCapture: ReturnType<typeof captureRecordingPageFrames> | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let resolveCapture!: (stream: MediaStream | PromiseLike<MediaStream>) => void;
  let rejectCapture!: (cause: unknown) => void;
  const capturePromise = new Promise<MediaStream>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  })
    .then((stream) => {
      capturedStream = stream;
      if (!acceptStream) {
        stopMediaStream(stream);
        capturedStream = null;
      }
      return stream;
    })
    .finally(() => clearTimeout(deadline));
  // Native acquisition can settle before the desktop IPC response reaches this caller.
  void capturePromise.catch(() => undefined);
  const pending: PendingTabMediaCapture = {
    start: (sourceId, size) => {
      // One budget covers native acquisition and the fallback's first decoded frame.
      deadline = setTimeout(() => {
        acceptStream = false;
        const cause = new BrowserRecordingCaptureTimeoutError({
          tabId,
          timeoutMs: BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
        });
        pageCapture?.dispose(cause);
        rejectCapture(cause);
      }, BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS);
      return Promise.race([
        Promise.resolve()
          .then(() => captureTabMediaStream(sourceId, frameRate, size))
          .then(
            (stream): true => {
              if (acceptStream) resolveCapture(stream);
              else stopMediaStream(stream);
              return true;
            },
            (cause): true | PageFrameCaptureRequest => {
              if (!acceptStream) return true;
              if (!(cause instanceof DOMException) || cause.name !== "NotReadableError") {
                rejectCapture(cause);
                return true;
              }
              // Chromium rejects new tab-capture sessions after a lock event. Record the
              // same app-owned guest's page frames without requesting another OS source.
              pageCapture = captureRecordingPageFrames(tabId, frameRate);
              resolveCapture(pageCapture.streamPromise);
              return { mode: "frame-subscription", captureId: pageCapture.captureId };
            },
          ),
        capturePromise.then(
          (): true => true,
          (): true => true,
        ),
      ]);
    },
  };
  pendingTabMediaCaptures.set(tabId, pending);
  return {
    capturePromise,
    adoptStream: () => {
      capturedStream = null;
    },
    cancel: () => {
      acceptStream = false;
      clearTimeout(deadline);
      if (capturedStream) {
        stopMediaStream(capturedStream);
        capturedStream = null;
      }
      pageCapture?.dispose();
      pageCapture = null;
      if (pendingTabMediaCaptures.get(tabId) === pending) pendingTabMediaCaptures.delete(tabId);
      rejectCapture(new BrowserRecordingStartCancelledError({ tabId }));
      void capturePromise.catch(() => undefined);
    },
  };
};

const triggerTabMediaCapture = (
  tabId: unknown,
  sourceId: unknown,
  size: unknown,
): false | Promise<true | PageFrameCaptureRequest> => {
  if (
    typeof tabId !== "string" ||
    typeof sourceId !== "string" ||
    sourceId.length === 0 ||
    typeof size !== "object" ||
    size === null ||
    !("width" in size) ||
    !("height" in size) ||
    typeof size.width !== "number" ||
    !Number.isInteger(size.width) ||
    size.width <= 0 ||
    typeof size.height !== "number" ||
    !Number.isInteger(size.height) ||
    size.height <= 0
  )
    return false;
  const pending = pendingTabMediaCaptures.get(tabId);
  if (!pending) return false;
  pendingTabMediaCaptures.delete(tabId);
  return pending.start(sourceId, { width: size.width, height: size.height });
};

Object.defineProperty(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER, {
  configurable: true,
  value: Object.assign(triggerTabMediaCapture, {
    // Private requester handoff: completion acknowledges decoded frame consumption.
    frame: (
      tabId: string,
      captureId: string,
      frame: DesktopPreviewRecordingFrame,
      sourceVersion: number,
    ) => {
      const capture = pageFrameCaptures.get(tabId);
      return capture?.captureId === captureId
        ? capture.receive(frame, sourceVersion)
        : Promise.resolve(false);
    },
    source: (tabId: string, captureId: string, sourceVersion: number) => {
      const capture = pageFrameCaptures.get(tabId);
      return capture?.captureId === captureId ? capture.replaceSource(sourceVersion) : false;
    },
    end: (tabId: string, captureId: string) => {
      const capture = pageFrameCaptures.get(tabId);
      if (capture?.captureId !== captureId) return false;
      capture.end();
      return true;
    },
  }),
});

const clearActiveRecording = (recording: ActiveRecording): void => {
  recording.releaseCapture?.();
  recording.releaseCapture = null;
  recording.compositor?.dispose();
  recording.compositor = null;
  recording.releaseSurfaceActivity?.();
  recording.releaseSurfaceActivity = null;
  if (activeRecordings.get(recording.tabId) !== recording) return;
  activeRecordings.delete(recording.tabId);
  publishActiveRecordingTabIds();
};

const waitForBrowserRecordingPaint = async (): Promise<void> => {
  let firstFrameId: number | null = null;
  let secondFrameId: number | null = null;
  let timeoutId: number | null = null;
  const painted = new Promise<void>((resolve) => {
    firstFrameId = window.requestAnimationFrame(() => {
      firstFrameId = null;
      secondFrameId = window.requestAnimationFrame(() => {
        secondFrameId = null;
        resolve();
      });
    });
  });
  const timedOut = new Promise<void>((resolve) => {
    timeoutId = window.setTimeout(resolve, BROWSER_RECORDING_PAINT_SETTLE_TIMEOUT_MS);
  });
  try {
    await Promise.race([painted, timedOut]);
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    if (firstFrameId !== null) window.cancelAnimationFrame(firstFrameId);
    if (secondFrameId !== null) window.cancelAnimationFrame(secondFrameId);
  }
};

const cleanupFailedRecordingStart = async (
  bridge: NonNullable<typeof previewBridge>,
  recording: ActiveRecording,
): Promise<unknown | undefined> => {
  const errors: unknown[] = [];
  try {
    await bridge.recording.stopScreencast(recording.tabId);
  } catch (error) {
    errors.push(error);
  }
  try {
    await stopMediaRecorder(recording.recorder);
  } catch (error) {
    errors.push(error);
  }
  try {
    stopMediaStream(recording.stream);
  } catch (error) {
    errors.push(error);
  } finally {
    clearActiveRecording(recording);
  }
  if (errors.length === 0) return undefined;
  if (errors.length === 1) return errors[0];
  return new AggregateError(
    errors,
    `Browser recording startup cleanup failed for tab ${recording.tabId}.`,
    { cause: errors[0] },
  );
};

const recordingStartupCancelledError = (
  recording: ActiveRecording,
  cause: unknown = new Error(`Browser recording startup was cancelled for tab ${recording.tabId}.`),
): BrowserRecordingOperationError =>
  new BrowserRecordingOperationError({
    operation: "start-screencast",
    tabId: recording.tabId,
    cause,
  });

const isRecordingStarting = (recording: ActiveRecording): boolean =>
  activeRecordings.get(recording.tabId) === recording && recording.lifecycle.phase === "starting";

const waitForRecordingStartupToSettle = async (recording: ActiveRecording): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      recording.startupSettled,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Browser recording startup did not settle for tab ${recording.tabId}.`));
        }, BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS);
      }),
    ]);
  } catch (cause) {
    throw new BrowserRecordingOperationError({
      operation: "wait-startup",
      tabId: recording.tabId,
      cause,
    });
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
};

const isStartupWaitTimeout = (error: unknown): error is BrowserRecordingOperationError =>
  isBrowserRecordingOperationError(error) && error.operation === "wait-startup";

export async function startBrowserRecording(
  tabId: string,
  threadRef: ScopedThreadRef | null = null,
  serverTabId = tabId,
): Promise<string> {
  const bridge = previewBridge;
  if (!bridge) throw new BrowserRecordingUnavailableError({ tabId });
  const activeRecording = activeRecordings.get(tabId);
  if (activeRecording) {
    if (activeRecording.lifecycle.phase === "recording") {
      return activeRecording.startedAt;
    }
    throw new BrowserRecordingConflictError({
      requestedTabId: tabId,
      activeTabId: activeRecording.tabId,
    });
  }
  const activeLogicalRecording =
    threadRef === null ? null : findActiveBrowserRecordingRuntimeTabId(threadRef, serverTabId);
  if (activeLogicalRecording !== null) {
    throw new BrowserRecordingConflictError({
      requestedTabId: tabId,
      activeTabId: activeLogicalRecording,
    });
  }
  const startedAt = new Date().toISOString();
  const chunks: Blob[] = [];
  let settleStartup: (() => void) | undefined;
  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });
  const releaseSurfaceActivity = acquireBrowserSurfaceActivity(tabId);
  const recording: ActiveRecording = {
    tabId,
    serverTabId,
    threadRef,
    chunks,
    startedAt,
    startupSettled,
    releaseSurfaceActivity,
    releaseCapture: null,
    stream: null,
    recorder: null,
    compositor: null,
    lifecycle: { phase: "starting" },
  };
  activeRecordings.set(tabId, recording);
  publishActiveRecordingTabIds();
  try {
    await ensureClientSettingsHydrated().catch((cause: unknown) => {
      clearActiveRecording(recording);
      throw cause;
    });
    const settings = getClientSettings();
    const frameRate = settings.browserRecordingFrameRate;
    await waitForBrowserRecordingPaint();
    const throwIfStartupCancelled = async (): Promise<void> => {
      // A stop joins startup so its caller can receive the resulting artifact.
      if (activeRecordings.get(tabId) === recording) return;
      try {
        await bridge.recording.stopScreencast(tabId);
      } catch (cause) {
        throw recordingStartupCancelledError(
          recording,
          new AggregateError(
            [new Error(`Browser recording startup was cancelled for tab ${tabId}.`), cause],
            `Browser recording startup cancellation failed for tab ${tabId}.`,
            { cause },
          ),
        );
      }
      throw recordingStartupCancelledError(recording);
    };
    const stream = await (async () => {
      await throwIfStartupCancelled();
      const capture = prepareTabMediaCapture(tabId, frameRate);
      recording.releaseCapture = capture.cancel;
      try {
        await bridge.recording.startScreencast(tabId);
      } catch (cause) {
        capture.cancel();
        if (!isRecordingStarting(recording)) {
          throw recordingStartupCancelledError(recording, cause);
        }
        clearActiveRecording(recording);
        throw new BrowserRecordingOperationError({
          operation: "start-screencast",
          tabId,
          cause,
        });
      }
      try {
        await throwIfStartupCancelled();
      } catch (cause) {
        capture.cancel();
        throw cause;
      }
      try {
        recording.stream = await capture.capturePromise;
        capture.adoptStream();
        return recording.stream;
      } catch (cause) {
        const cleanupCause = await cleanupFailedRecordingStart(bridge, recording);
        if (isBrowserRecordingCaptureTimeoutError(cause) && cleanupCause === undefined) throw cause;
        throw new BrowserRecordingOperationError({
          operation: "capture-media-stream",
          tabId,
          cause:
            cleanupCause === undefined
              ? cause
              : new AggregateError(
                  [cause, cleanupCause],
                  `Browser media capture and cleanup failed for tab ${tabId}.`,
                  { cause },
                ),
        });
      }
    })();
    await throwIfStartupCancelled();

    let recorder: MediaRecorder;
    try {
      recording.compositor = await createRecordingCompositor(
        stream,
        {
          showKeyPresses: settings.browserRecordingShowKeyPresses,
          showMousePresses: settings.browserRecordingShowMousePresses,
          frameRate,
        },
        (listener) =>
          bridge.recording.onInput((event) => {
            if (event.tabId === tabId) listener(event.input);
          }),
      );
      recorder = createMediaRecorder(recording.compositor?.stream ?? stream);
      recording.recorder = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
    } catch (cause) {
      const cleanupCause = await cleanupFailedRecordingStart(bridge, recording);
      throw new BrowserRecordingOperationError({
        operation: "initialize-media-recorder",
        tabId,
        cause:
          cleanupCause === undefined
            ? cause
            : new AggregateError(
                [cause, cleanupCause],
                `Browser recording initialization and cleanup failed for tab ${tabId}.`,
                { cause },
              ),
      });
    }
    try {
      recorder.start(1_000);
    } catch (cause) {
      const cleanupCause = await cleanupFailedRecordingStart(bridge, recording);
      throw new BrowserRecordingOperationError({
        operation: "start-media-recorder",
        tabId,
        cause:
          cleanupCause === undefined
            ? cause
            : new AggregateError(
                [cause, cleanupCause],
                `Browser media recorder start and cleanup failed for tab ${tabId}.`,
                { cause },
              ),
      });
    }
    if (recording.lifecycle.phase === "starting") {
      recording.lifecycle = { phase: "recording" };
    }
    return startedAt;
  } finally {
    settleStartup?.();
  }
}

const finalizeBrowserRecording = async (
  bridge: NonNullable<typeof previewBridge>,
  recording: ActiveRecording,
): Promise<DesktopPreviewRecordingArtifact | null> => {
  const { tabId } = recording;
  let result:
    | {
        readonly _tag: "Success";
        readonly artifact: DesktopPreviewRecordingArtifact | null;
      }
    | { readonly _tag: "Failure"; readonly error: unknown };
  try {
    await waitForRecordingStartupToSettle(recording);
    try {
      await bridge.recording.stopScreencast(tabId);
    } catch (cause) {
      throw new BrowserRecordingOperationError({
        operation: "stop-screencast",
        tabId,
        cause,
      });
    }
    if (!recording.recorder) {
      result = { _tag: "Success", artifact: null };
    } else {
      try {
        await stopMediaRecorder(recording.recorder);
      } catch (cause) {
        throw new BrowserRecordingOperationError({
          operation: "stop-media-recorder",
          tabId,
          cause,
        });
      }
      recording.compositor?.dispose();
      recording.compositor = null;
      // Encoding has flushed; release native capture before materializing and saving the file.
      stopMediaStream(recording.stream);
      recording.stream = null;
      const mimeType =
        recording.recorder.mimeType ||
        recording.chunks.find((chunk) => chunk.type.length > 0)?.type;
      if (!mimeType) {
        throw new BrowserRecordingFormatUnavailableError({ tabId });
      }
      try {
        const blob = new Blob(recording.chunks, { type: mimeType });
        const artifact = await bridge.recording.save(
          tabId,
          mimeType,
          new Uint8Array(await blob.arrayBuffer()),
        );
        recording.savedBlob = blob;
        result = { _tag: "Success", artifact };
      } catch (cause) {
        throw new BrowserRecordingOperationError({
          operation: "save-artifact",
          tabId,
          cause,
        });
      }
    }
  } catch (error) {
    result = { _tag: "Failure", error };
  }

  if (result._tag === "Failure" && isStartupWaitTimeout(result.error)) {
    // Do not clear `active` yet. The renderer-side start promise can still
    // resolve later, and its cancellation path will call `stopScreencast`.
    // Keeping the slot reserved prevents a newer recording for this tab from
    // being started and then accidentally stopped by the older late cleanup.
    throw result.error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    await stopMediaRecorder(recording.recorder);
  } catch (cause) {
    cleanupErrors.push(cause);
  }
  try {
    stopMediaStream(recording.stream);
  } catch (cause) {
    cleanupErrors.push(cause);
  } finally {
    clearActiveRecording(recording);
  }
  const cleanupError =
    cleanupErrors.length === 0
      ? undefined
      : new BrowserRecordingOperationError({
          operation: "cleanup",
          tabId,
          cause:
            cleanupErrors.length === 1
              ? cleanupErrors[0]
              : new AggregateError(
                  cleanupErrors,
                  `Browser recording media cleanup failed for tab ${tabId}.`,
                  { cause: cleanupErrors[0] },
                ),
        });

  if (result._tag === "Failure") {
    if (cleanupError) {
      throw new BrowserRecordingOperationError({
        operation: "cleanup",
        tabId,
        cause: new AggregateError(
          [result.error, cleanupError],
          `Browser recording stop and cleanup failed for tab ${tabId}.`,
          { cause: result.error },
        ),
      });
    }
    throw result.error;
  }
  if (cleanupError) throw cleanupError;
  return result.artifact;
};

const discardBrowserRecording = async (
  bridge: NonNullable<typeof previewBridge>,
  recording: ActiveRecording,
): Promise<null> => {
  try {
    await bridge.recording.stopScreencast(recording.tabId).catch(() => undefined);
    await stopMediaRecorder(recording.recorder).catch(() => undefined);
    stopMediaStream(recording.stream);
    return null;
  } finally {
    clearActiveRecording(recording);
  }
};

export function stopBrowserRecording(
  tabId: string,
): Promise<DesktopPreviewRecordingArtifact | null> {
  const bridge = previewBridge;
  const recording = activeRecordings.get(tabId);
  if (!bridge || !recording) return Promise.resolve(null);
  if (recording.lifecycle.phase === "stopping") return recording.lifecycle.stopPromise;

  const stopPromise = Promise.resolve()
    .then(() => finalizeBrowserRecording(bridge, recording))
    .catch((error) => {
      if (isStartupWaitTimeout(error) && activeRecordings.get(recording.tabId) === recording) {
        const cleanupAfterStartup = recording.startupSettled.then(() =>
          discardBrowserRecording(bridge, recording),
        );
        recording.lifecycle = { phase: "stopping", stopPromise: cleanupAfterStartup };
        void cleanupAfterStartup.catch(() => undefined);
      }
      throw error;
    });
  recording.lifecycle = { phase: "stopping", stopPromise };
  return stopPromise;
}

/** Joins local stops and shares one upload among concurrent automation requests. */
export async function stopBrowserRecordingForUpload(
  tabId: string,
  upload: (artifact: DesktopPreviewRecordingArtifact, blob: Blob) => Promise<string>,
): Promise<(DesktopPreviewRecordingArtifact & { uploadedAttachmentId: string }) | null> {
  const recording = activeRecordings.get(tabId);
  if (!recording) return null;
  const artifact = await stopBrowserRecording(tabId);
  if (!artifact || !recording.savedBlob) return null;
  recording.uploadPromise ??= upload(artifact, recording.savedBlob);
  return { ...artifact, uploadedAttachmentId: await recording.uploadPromise };
}
