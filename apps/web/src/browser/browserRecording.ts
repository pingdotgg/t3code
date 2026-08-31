import type {
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingSource,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";
import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";

export class BrowserRecordingUnavailableError extends Schema.TaggedErrorClass<BrowserRecordingUnavailableError>()(
  "BrowserRecordingUnavailableError",
  {
    tabId: Schema.String,
  },
) {
  override get message(): string {
    return `Browser recording is unavailable for tab ${this.tabId}.`;
  }
}

export class BrowserRecordingConflictError extends Schema.TaggedErrorClass<BrowserRecordingConflictError>()(
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

export class BrowserRecordingFormatUnavailableError extends Schema.TaggedErrorClass<BrowserRecordingFormatUnavailableError>()(
  "BrowserRecordingFormatUnavailableError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `MediaRecorder did not report an output format for tab ${this.tabId}.`;
  }
}

export class BrowserRecordingCaptureTimeoutError extends Schema.TaggedErrorClass<BrowserRecordingCaptureTimeoutError>()(
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

export class BrowserRecordingOperationError extends Schema.TaggedErrorClass<BrowserRecordingOperationError>()(
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

type BrowserRecordingLifecycle =
  | { readonly phase: "starting" }
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
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
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
  "video/webm;codecs=av1",
  "video/webm;codecs=vp9",
  "video/mp4;codecs=avc1.640028",
  "video/mp4;codecs=avc1.42e01e",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

const createMediaRecorder = (stream: MediaStream): MediaRecorder => {
  const mimeType = preferredMimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  return mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
};

const captureTabMediaStream = (
  source: DesktopPreviewRecordingSource,
  frameRate: number,
): Promise<MediaStream> =>
  navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: source.sourceId,
        minWidth: source.width,
        maxWidth: source.width,
        minHeight: source.height,
        maxHeight: source.height,
        maxFrameRate: frameRate,
      },
    } as unknown as MediaTrackConstraints,
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

const captureTabMediaStreamWithTimeout = async (
  tabId: string,
  source: DesktopPreviewRecordingSource,
  frameRate: number,
): Promise<MediaStream> => {
  let acceptStream = true;
  let timeoutId: number | null = null;
  const streamPromise = captureTabMediaStream(source, frameRate).then((stream) => {
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

const clearActiveRecording = (recording: ActiveRecording): void => {
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
    stream: null,
    recorder: null,
    lifecycle: { phase: "starting" },
  };
  activeRecordings.set(tabId, recording);
  publishActiveRecordingTabIds();
  try {
    const frameRatePromise = ensureClientSettingsHydrated().then(
      () => getClientSettings().browserRecordingFrameRate,
    );
    const [frameRate] = await Promise.all([frameRatePromise, waitForBrowserRecordingPaint()]);
    let source: DesktopPreviewRecordingSource;
    try {
      source = await bridge.recording.startScreencast(tabId);
    } catch (cause) {
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
    const throwIfStartupCancelled = async (): Promise<void> => {
      // A stop requested during startup should let startup finish so the
      // caller receives a real artifact. Only replacement/removal cancels it.
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
    await throwIfStartupCancelled();
    try {
      recording.stream = await captureTabMediaStreamWithTimeout(tabId, source, frameRate);
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
    await throwIfStartupCancelled();

    let recorder: MediaRecorder;
    try {
      recorder = createMediaRecorder(recording.stream);
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
