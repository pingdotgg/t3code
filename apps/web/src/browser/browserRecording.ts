import {
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
  PreviewCaptureFailure,
} from "@t3tools/contracts";
import type { DesktopPreviewRecordingArtifact, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";
import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { createRecordingCompositor } from "./recordingCompositor";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";
import { isStartupWaitTimeout } from "./browserRecordingParts";

const isPreviewCaptureFailure = Schema.is(PreviewCaptureFailure);

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
    if (isPreviewCaptureFailure(this.cause)) {
      return this.cause.message;
    }
    // Stream acquisition stores its primary failure on the aggregate when cleanup also fails.
    const captureCause = this.cause instanceof AggregateError ? this.cause.cause : this.cause;
    if (
      this.operation === "capture-media-stream" &&
      captureCause instanceof DOMException &&
      captureCause.name === "NotReadableError"
    ) {
      return (
        "Unable to start the preview video source. Make sure the capture host is unlocked " +
        "and its display is on, then retry. " +
        `${captureCause.name}: ${captureCause.message}`
      );
    }
    return `Browser recording operation ${this.operation} failed for tab ${this.tabId}.`;
  }
}

export const isBrowserRecordingOperationError = Schema.is(BrowserRecordingOperationError);
export const isBrowserRecordingCaptureTimeoutError = Schema.is(BrowserRecordingCaptureTimeoutError);
export const isBrowserRecordingStartCancelledError = Schema.is(BrowserRecordingStartCancelledError);

interface StartingBrowserRecordingLifecycle {
  readonly phase: "starting";
  queuedForGrant: boolean | null;
  grantStarted: boolean;
  stopRequestedBeforeGrant: boolean;
  cancelledBeforeGrant: boolean;
  readonly cancelledBeforeGrantSignal: Promise<void>;
  readonly cancelBeforeGrant: () => void;
  readonly setQueuedForGrant: (queued: boolean) => void;
}

type BrowserRecordingLifecycle =
  | StartingBrowserRecordingLifecycle
  | { readonly phase: "recording" }
  | {
      readonly phase: "stopping";
      readonly stopPromise: Promise<DesktopPreviewRecordingArtifact | null>;
    };

export interface ActiveRecording {
  readonly tabId: string;
  readonly serverTabId: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly chunks: Blob[];
  readonly startedAt: string;
  readonly startupSettled: Promise<void>;
  releaseSurfaceActivity: (() => void) | null;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  compositor: Awaited<ReturnType<typeof createRecordingCompositor>>;
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

export const activeRecordings = new Map<string, ActiveRecording>();
let displayMediaGrantTail = Promise.resolve();
let displayMediaGrantQueueDepth = 0;

export const makeStartingBrowserRecordingLifecycle = (): StartingBrowserRecordingLifecycle => {
  let signalCancellation!: () => void;
  const cancelledBeforeGrantSignal = new Promise<void>((resolve) => {
    signalCancellation = resolve;
  });
  const lifecycle: StartingBrowserRecordingLifecycle = {
    phase: "starting",
    queuedForGrant: null,
    grantStarted: false,
    stopRequestedBeforeGrant: false,
    cancelledBeforeGrant: false,
    cancelledBeforeGrantSignal,
    cancelBeforeGrant: () => {
      lifecycle.stopRequestedBeforeGrant = true;
      if (lifecycle.queuedForGrant && !lifecycle.grantStarted && !lifecycle.cancelledBeforeGrant) {
        lifecycle.cancelledBeforeGrant = true;
        signalCancellation();
      }
    },
    setQueuedForGrant: (queued) => {
      lifecycle.queuedForGrant = queued;
      if (queued && lifecycle.stopRequestedBeforeGrant) lifecycle.cancelBeforeGrant();
    },
  };
  return lifecycle;
};

export const queueDisplayMediaGrant = <T>(
  useGrant: () => Promise<T>,
): { readonly queued: boolean; readonly result: Promise<T> } => {
  const queued = displayMediaGrantQueueDepth > 0;
  displayMediaGrantQueueDepth += 1;
  const result = displayMediaGrantTail.then(useGrant);
  const settleGrant = () => {
    displayMediaGrantQueueDepth -= 1;
  };
  displayMediaGrantTail = result.then(
    () => settleGrant(),
    () => settleGrant(),
  );
  return { queued, result };
};

export const publishActiveRecordingTabIds = (): void => {
  appAtomRegistry.set(activeBrowserRecordingTabIdsAtom, {
    tabIds: new Set(activeRecordings.keys()),
  });
};

const BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS = 5_000;
const BROWSER_RECORDING_PAINT_SETTLE_TIMEOUT_MS = 250;

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

export const createMediaRecorder = (stream: MediaStream): MediaRecorder => {
  const mimeType = preferredMimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  const settings = stream.getVideoTracks()[0]?.getSettings();
  const videoBitsPerSecond = Math.round(
    Math.min(
      50_000_000,
      Math.max(
        2_500_000,
        (settings?.width ?? 1920) * (settings?.height ?? 1080) * (settings?.frameRate ?? 30) * 0.05,
      ),
    ),
  );
  return new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond });
};

const captureTabMediaStream = (frameRate: number): Promise<MediaStream> =>
  // The armed tab supplies native-size frames without source or dimension constraints.
  navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: { frameRate: { ideal: frameRate, max: frameRate } },
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

interface PendingTabMediaCapture {
  readonly start: () => void;
}

const pendingTabMediaCaptures = new Map<string, PendingTabMediaCapture>();

export const prepareTabMediaCapture = (tabId: string, frameRate: number) => {
  let acceptStream = true;
  let capturedStream: MediaStream | null = null;
  let resolveCapture!: (stream: MediaStream | PromiseLike<MediaStream>) => void;
  let rejectCapture!: (cause: unknown) => void;
  const capturePromise = new Promise<MediaStream>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  }).then((stream) => {
    capturedStream = stream;
    if (!acceptStream) {
      stopMediaStream(stream);
      capturedStream = null;
    }
    return stream;
  });
  const pending: PendingTabMediaCapture = {
    start: () => {
      try {
        // executeJavaScript(..., true) supplies transient activation for automated or delayed capture.
        resolveCapture(captureTabMediaStream(frameRate));
      } catch (cause) {
        rejectCapture(cause);
      }
    },
  };
  pendingTabMediaCaptures.set(tabId, pending);
  return {
    capturePromise,
    cancel: () => {
      acceptStream = false;
      if (capturedStream) {
        stopMediaStream(capturedStream);
        capturedStream = null;
      }
      if (pendingTabMediaCaptures.get(tabId) === pending) pendingTabMediaCaptures.delete(tabId);
      void capturePromise.catch(() => undefined);
    },
  };
};

const triggerTabMediaCapture = (tabId: unknown): boolean => {
  if (typeof tabId !== "string") return false;
  const pending = pendingTabMediaCaptures.get(tabId);
  if (!pending) return false;
  pendingTabMediaCaptures.delete(tabId);
  pending.start();
  return true;
};

Object.defineProperty(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER, {
  configurable: true,
  value: triggerTabMediaCapture,
});

export const captureTabMediaStreamWithTimeout = async (
  tabId: string,
  capturePromise: Promise<MediaStream>,
): Promise<MediaStream> => {
  let acceptStream = true;
  let timeoutId: number | null = null;
  const streamPromise = capturePromise.then((stream) => {
    if (!acceptStream) stopMediaStream(stream);
    return stream;
  });
  try {
    return await Promise.race([
      streamPromise,
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(
          () =>
            reject(
              new BrowserRecordingCaptureTimeoutError({
                tabId,
                timeoutMs: BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
              }),
            ),
          BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    acceptStream = false;
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }
};

export const clearActiveRecording = (recording: ActiveRecording): void => {
  recording.compositor?.dispose();
  recording.compositor = null;
  recording.releaseSurfaceActivity?.();
  recording.releaseSurfaceActivity = null;
  if (activeRecordings.get(recording.tabId) !== recording) return;
  activeRecordings.delete(recording.tabId);
  publishActiveRecordingTabIds();
};

export const waitForBrowserRecordingPaint = async (): Promise<void> => {
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

export const cleanupFailedRecordingStart = async (
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

export const recordingStartupCancelledError = (
  recording: ActiveRecording,
  cause: unknown = new Error(`Browser recording startup was cancelled for tab ${recording.tabId}.`),
): BrowserRecordingOperationError =>
  new BrowserRecordingOperationError({
    operation: "start-screencast",
    tabId: recording.tabId,
    cause,
  });

export const isRecordingStarting = (recording: ActiveRecording): boolean =>
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
    // Reserve the slot until late-start cancellation finishes, or it could stop a newer recording.
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
  if (recording.lifecycle.phase === "starting") recording.lifecycle.cancelBeforeGrant();

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

export * from "./browserRecordingParts";
