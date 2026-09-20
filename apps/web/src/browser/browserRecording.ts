import {
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
  PreviewAutomationRecordingDeadlineExpiredError,
} from "@t3tools/contracts";
import type { DesktopPreviewRecordingArtifact, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";
import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";

const isRecordingUploadDeadlineExpired = Schema.is(PreviewAutomationRecordingDeadlineExpiredError);

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
      "stop-deadline",
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

interface ActiveRecording {
  /** Desktop-scoped identity used by the native capture lease. */
  readonly tabId: string;
  /** Server-local identity returned by preview automation tools. */
  readonly serverTabId: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly chunks: Blob[];
  readonly startedAt: string;
  readonly startupSettled: Promise<void>;
  readonly artifactSaveKey: string;
  artifactSave: Promise<DesktopPreviewRecordingArtifact> | null;
  releaseSurfaceActivity: (() => void) | null;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  recorderStopped: Promise<void> | null;
  retainForUpload: boolean;
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
let displayMediaGrantTail = Promise.resolve();
let displayMediaGrantQueueDepth = 0;

const makeStartingBrowserRecordingLifecycle = (): StartingBrowserRecordingLifecycle => {
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
      // Queue position is unknown during paint/settings warmup. Keep the stop request so a start
      // that later turns out to be contended can still be cancelled before native capture.
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

const queueDisplayMediaGrant = <T>(
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
        (settings?.width ?? 1920) * (settings?.height ?? 1080) * (settings?.frameRate ?? 30) * 0.05,
      ),
    ),
  );
  return new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond });
};

const captureTabMediaStream = (frameRate: number): Promise<MediaStream> =>
  // The desktop main process routes this request to the tab that `startScreencast` armed, so the
  // stream already arrives at that tab's native size and needs no source or dimension constraints.
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

const prepareTabMediaCapture = (tabId: string, frameRate: number) => {
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
        // Electron invokes this callback through executeJavaScript(..., true), so even automated
        // and delayed queued starts satisfy getDisplayMedia's transient-activation requirement.
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

const captureTabMediaStreamWithTimeout = async (
  tabId: string,
  capturePromise: Promise<MediaStream>,
  timeoutMs = BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
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
                timeoutMs,
              }),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    acceptStream = false;
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }
};

const clearActiveRecording = (recording: ActiveRecording): void => {
  recording.releaseSurfaceActivity?.();
  recording.releaseSurfaceActivity = null;
  if (activeRecordings.get(recording.tabId) !== recording) return;
  activeRecordings.delete(recording.tabId);
  publishActiveRecordingTabIds();
};

const waitForBrowserRecordingPaint = async (
  timeoutMs = BROWSER_RECORDING_PAINT_SETTLE_TIMEOUT_MS,
): Promise<void> => {
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
    timeoutId = window.setTimeout(
      resolve,
      Math.min(BROWSER_RECORDING_PAINT_SETTLE_TIMEOUT_MS, timeoutMs),
    );
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
  deadline: number | null,
  options: { readonly ignoreDeadlineExpiry?: boolean } = {},
): Promise<unknown | undefined> => {
  const errors: unknown[] = [];
  const deadlineError = new Error(
    `Browser recording startup cleanup exceeded its deadline for tab ${recording.tabId}.`,
  );
  try {
    const remainingMs = deadline === null ? undefined : Math.max(0, deadline - Date.now());
    const stop =
      remainingMs === undefined
        ? bridge.recording.stopScreencast(recording.tabId)
        : bridge.recording.stopScreencast(recording.tabId, Math.max(1, remainingMs));
    if (remainingMs === undefined) {
      await stop;
    } else {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          stop,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(deadlineError), remainingMs);
          }),
        ]);
      } finally {
        if (timeout !== null) clearTimeout(timeout);
      }
    }
  } catch (error) {
    if (!options.ignoreDeadlineExpiry || error !== deadlineError) errors.push(error);
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

const recordingStopDeadlineError = (
  tabId: string,
  cause: unknown = new Error(`Browser recording stop exceeded its deadline for tab ${tabId}.`),
): BrowserRecordingOperationError =>
  new BrowserRecordingOperationError({
    operation: "stop-deadline",
    tabId,
    cause,
  });

export const isBrowserRecordingStopDeadlineError = (
  error: unknown,
): error is BrowserRecordingOperationError =>
  isBrowserRecordingOperationError(error) && error.operation === "stop-deadline";

const isDesktopRecordingTimeout = (error: unknown): boolean => {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (
      ("_tag" in current &&
        (current as { readonly _tag?: unknown })._tag === "PreviewAutomationTimeoutError") ||
      ("name" in current &&
        (current as { readonly name?: unknown }).name === "PreviewAutomationTimeoutError")
    ) {
      return true;
    }
    current = "cause" in current ? (current as { readonly cause?: unknown }).cause : undefined;
  }
  return false;
};

const remainingRecordingStopBudget = (
  deadline: number | null,
  tabId: string,
): number | undefined => {
  if (deadline === null) return undefined;
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw recordingStopDeadlineError(tabId);
  return remainingMs;
};

const awaitWithinRecordingStopDeadline = async <A>(
  promise: Promise<A>,
  deadline: number | null,
  tabId: string,
): Promise<A> => {
  const remainingMs = remainingRecordingStopBudget(deadline, tabId);
  if (remainingMs === undefined) return await promise;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(recordingStopDeadlineError(tabId)), remainingMs);
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
};

export async function startBrowserRecording(
  tabId: string,
  threadRef: ScopedThreadRef | null = null,
  serverTabId = tabId,
  timeoutMs?: number,
): Promise<string> {
  const bridge = previewBridge;
  if (!bridge) throw new BrowserRecordingUnavailableError({ tabId });
  const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
  const remainingStartupBudget = (): number | undefined =>
    deadline === null ? undefined : Math.max(0, deadline - Date.now());
  const startupDeadlineError = new BrowserRecordingCaptureTimeoutError({
    tabId,
    timeoutMs: timeoutMs ?? 0,
  });
  const awaitStartup = async <A>(promise: Promise<A>): Promise<A> => {
    const remainingMs = remainingStartupBudget();
    if (remainingMs === undefined) return await promise;
    if (remainingMs <= 0) {
      void promise.catch(() => undefined);
      throw startupDeadlineError;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(startupDeadlineError), remainingMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
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
  const startingLifecycle = makeStartingBrowserRecordingLifecycle();
  const releaseSurfaceActivity = acquireBrowserSurfaceActivity(tabId);
  const recording: ActiveRecording = {
    tabId,
    serverTabId,
    threadRef,
    chunks,
    startedAt,
    startupSettled,
    artifactSaveKey: randomUUID(),
    artifactSave: null,
    retainForUpload: false,
    releaseSurfaceActivity,
    stream: null,
    recorder: null,
    recorderStopped: null,
    lifecycle: startingLifecycle,
  };
  activeRecordings.set(tabId, recording);
  publishActiveRecordingTabIds();
  let cancelCapture: (() => void) | undefined;
  try {
    await awaitStartup(ensureClientSettingsHydrated()).catch((cause: unknown) => {
      clearActiveRecording(recording);
      throw cause;
    });
    const frameRate = getClientSettings().browserRecordingFrameRate;
    await awaitStartup(waitForBrowserRecordingPaint(remainingStartupBudget()));
    if (remainingStartupBudget() === 0) throw startupDeadlineError;
    const throwIfStartupCancelled = async (): Promise<void> => {
      // Once a grant starts, a stop lets startup finish so the caller receives an artifact.
      // Only a contended start can be cancelled before it reaches native capture.
      if (activeRecordings.get(tabId) === recording) return;
      try {
        const stopBudget = remainingStartupBudget();
        if (stopBudget === undefined) await bridge.recording.stopScreencast(tabId);
        else await bridge.recording.stopScreencast(tabId, Math.max(1, stopBudget));
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
    // The desktop process exposes one display-media grant at a time. Keep only the
    // arm-to-capture handoff exclusive; acquired streams can record concurrently.
    const grant = queueDisplayMediaGrant(async () => {
      if (startingLifecycle.cancelledBeforeGrant) {
        throw new BrowserRecordingStartCancelledError({ tabId });
      }
      startingLifecycle.grantStarted = true;
      await throwIfStartupCancelled();
      const capture = prepareTabMediaCapture(tabId, frameRate);
      cancelCapture = capture.cancel;
      try {
        const startBudget = remainingStartupBudget();
        if (startBudget === undefined) await bridge.recording.startScreencast(tabId);
        else await bridge.recording.startScreencast(tabId, Math.max(1, startBudget));
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
        const captureBudget = remainingStartupBudget();
        recording.stream = await captureTabMediaStreamWithTimeout(
          tabId,
          capture.capturePromise,
          captureBudget === undefined
            ? BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS
            : Math.max(1, Math.min(BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS, captureBudget)),
        );
        return recording.stream;
      } catch (cause) {
        const cleanupCause = await cleanupFailedRecordingStart(bridge, recording, deadline);
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
    });
    startingLifecycle.setQueuedForGrant(grant.queued);
    const stream = await awaitStartup(
      Promise.race([
        grant.result,
        startingLifecycle.cancelledBeforeGrantSignal.then(() => {
          throw new BrowserRecordingStartCancelledError({ tabId });
        }),
      ]),
    );
    await throwIfStartupCancelled();

    let recorder: MediaRecorder;
    try {
      recorder = createMediaRecorder(stream);
      recording.recorder = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
    } catch (cause) {
      const cleanupCause = await cleanupFailedRecordingStart(bridge, recording, deadline);
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
      const cleanupCause = await cleanupFailedRecordingStart(bridge, recording, deadline);
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
  } catch (cause) {
    if (cause === startupDeadlineError) {
      startingLifecycle.cancelBeforeGrant();
      cancelCapture?.();
      if (startingLifecycle.grantStarted) {
        // The startup budget is already exhausted; only genuine cleanup failures add diagnostics.
        const cleanupCause = await cleanupFailedRecordingStart(bridge, recording, deadline, {
          ignoreDeadlineExpiry: true,
        });
        if (cleanupCause !== undefined) {
          throw new BrowserRecordingOperationError({
            operation: "cleanup",
            tabId,
            cause: new AggregateError(
              [cause, cleanupCause],
              `Browser recording startup and cleanup failed for tab ${tabId}.`,
              { cause },
            ),
          });
        }
      } else {
        clearActiveRecording(recording);
      }
    }
    throw cause;
  } finally {
    settleStartup?.();
  }
}

const finalizeBrowserRecording = async (
  bridge: NonNullable<typeof previewBridge>,
  recording: ActiveRecording,
  deadline: number | null,
): Promise<DesktopPreviewRecordingArtifact | null> => {
  const { tabId } = recording;
  let result:
    | {
        readonly _tag: "Success";
        readonly artifact: DesktopPreviewRecordingArtifact | null;
      }
    | { readonly _tag: "Failure"; readonly error: unknown };
  try {
    await awaitWithinRecordingStopDeadline(
      waitForRecordingStartupToSettle(recording),
      deadline,
      tabId,
    );
    try {
      const stopBudget = remainingRecordingStopBudget(deadline, tabId);
      await awaitWithinRecordingStopDeadline(
        stopBudget === undefined
          ? bridge.recording.stopScreencast(tabId)
          : bridge.recording.stopScreencast(tabId, stopBudget),
        deadline,
        tabId,
      );
    } catch (cause) {
      if (isBrowserRecordingStopDeadlineError(cause)) throw cause;
      if (isDesktopRecordingTimeout(cause)) throw recordingStopDeadlineError(tabId, cause);
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
        await awaitWithinRecordingStopDeadline(
          (recording.recorderStopped ??= stopMediaRecorder(recording.recorder)),
          deadline,
          tabId,
        );
      } catch (cause) {
        if (isBrowserRecordingStopDeadlineError(cause)) throw cause;
        throw new BrowserRecordingOperationError({
          operation: "stop-media-recorder",
          tabId,
          cause,
        });
      }
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
        let artifactSave = recording.artifactSave;
        if (!artifactSave) {
          const data = new Uint8Array(
            await awaitWithinRecordingStopDeadline(blob.arrayBuffer(), deadline, tabId),
          );
          const saveBudget = remainingRecordingStopBudget(deadline, tabId);
          const saveOperation =
            saveBudget === undefined
              ? bridge.recording.save(tabId, mimeType, data, recording.artifactSaveKey)
              : bridge.recording.save(tabId, mimeType, data, recording.artifactSaveKey, saveBudget);
          const trackedSave = saveOperation.catch((cause) => {
            if (recording.artifactSave === trackedSave) recording.artifactSave = null;
            throw cause;
          });
          recording.artifactSave = trackedSave;
          artifactSave = trackedSave;
        }
        const artifact = await awaitWithinRecordingStopDeadline(artifactSave, deadline, tabId);
        recording.savedBlob = blob;
        result = { _tag: "Success", artifact };
      } catch (cause) {
        if (isBrowserRecordingStopDeadlineError(cause)) throw cause;
        if (isDesktopRecordingTimeout(cause)) throw recordingStopDeadlineError(tabId, cause);
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

  if (
    result._tag === "Failure" &&
    (isStartupWaitTimeout(result.error) || isBrowserRecordingStopDeadlineError(result.error))
  ) {
    // Keep the slot and captured chunks available. Startup may still need its
    // cancellation cleanup, while a deadline failure can be retried to finish
    // saving an already-stopped MediaRecorder without losing its artifact.
    throw result.error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    await (recording.recorderStopped ??= stopMediaRecorder(recording.recorder));
  } catch (cause) {
    cleanupErrors.push(cause);
  }
  try {
    stopMediaStream(recording.stream);
  } catch (cause) {
    cleanupErrors.push(cause);
  } finally {
    recording.releaseSurfaceActivity?.();
    recording.releaseSurfaceActivity = null;
    if (result._tag === "Failure" || !result.artifact || !recording.retainForUpload) {
      clearActiveRecording(recording);
    }
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
  if (cleanupError) {
    clearActiveRecording(recording);
    throw cleanupError;
  }
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

function stopRecording(
  tabId: string,
  timeoutMs: number | undefined,
  retainForUpload: boolean,
): Promise<DesktopPreviewRecordingArtifact | null> {
  const bridge = previewBridge;
  const recording = activeRecordings.get(tabId);
  if (!bridge || !recording) return Promise.resolve(null);
  const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
  recording.retainForUpload = retainForUpload;
  if (recording.lifecycle.phase === "stopping") {
    return awaitWithinRecordingStopDeadline(recording.lifecycle.stopPromise, deadline, tabId).then(
      (artifact) => {
        if (!recording.retainForUpload) clearActiveRecording(recording);
        return artifact;
      },
    );
  }
  if (recording.lifecycle.phase === "starting") recording.lifecycle.cancelBeforeGrant();

  const stopPromise = Promise.resolve()
    .then(() => finalizeBrowserRecording(bridge, recording, deadline))
    .catch((error) => {
      if (
        isBrowserRecordingStopDeadlineError(error) &&
        activeRecordings.get(recording.tabId) === recording &&
        recording.lifecycle.phase === "stopping" &&
        recording.lifecycle.stopPromise === stopPromise
      ) {
        recording.lifecycle = { phase: "recording" };
      }
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

export function stopBrowserRecording(
  tabId: string,
  timeoutMs?: number,
): Promise<DesktopPreviewRecordingArtifact | null> {
  return stopRecording(tabId, timeoutMs, false);
}

/** Retains the saved file until a transfer succeeds; retries join an unsettled upload. */
export async function stopBrowserRecordingForUpload(
  tabId: string,
  upload: (artifact: DesktopPreviewRecordingArtifact, blob: Blob) => Promise<string>,
  timeoutMs?: number,
): Promise<(DesktopPreviewRecordingArtifact & { uploadedAttachmentId: string }) | null> {
  const recording = activeRecordings.get(tabId);
  if (!recording) return null;
  const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
  const artifact = await stopRecording(tabId, timeoutMs, true);
  if (!artifact || !recording.savedBlob) return null;
  remainingRecordingStopBudget(deadline, tabId);
  const blob = recording.savedBlob;
  const joinedUpload = recording.uploadPromise !== undefined;
  const getUploadPromise = () => {
    if (recording.uploadPromise) return recording.uploadPromise;
    const pendingUpload = Promise.resolve()
      .then(() => upload(artifact, blob))
      .catch((error) => {
        if (recording.uploadPromise === pendingUpload) delete recording.uploadPromise;
        throw error;
      });
    recording.uploadPromise = pendingUpload;
    // The request can expire before the retained upload settles.
    void pendingUpload.catch(() => undefined);
    return pendingUpload;
  };
  let uploadedAttachmentId: string;
  try {
    uploadedAttachmentId = await awaitWithinRecordingStopDeadline(
      getUploadPromise(),
      deadline,
      tabId,
    );
  } catch (error) {
    if (!joinedUpload || !isRecordingUploadDeadlineExpired(error)) {
      throw error;
    }
    // A joined transfer may still carry the previous stop request's expired deadline.
    remainingRecordingStopBudget(deadline, tabId);
    uploadedAttachmentId = await awaitWithinRecordingStopDeadline(
      getUploadPromise(),
      deadline,
      tabId,
    );
  }
  remainingRecordingStopBudget(deadline, tabId);
  clearActiveRecording(recording);
  return { ...artifact, uploadedAttachmentId };
}
