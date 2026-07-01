import type {
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";

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

export class BrowserRecordingCanvasUnavailableError extends Schema.TaggedErrorClass<BrowserRecordingCanvasUnavailableError>()(
  "BrowserRecordingCanvasUnavailableError",
  {
    tabId: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
  },
) {
  override get message(): string {
    return `Browser recording canvas ${this.width}x${this.height} is unavailable for tab ${this.tabId}.`;
  }
}

export class BrowserRecordingRequiresVisibleTabError extends Schema.TaggedErrorClass<BrowserRecordingRequiresVisibleTabError>()(
  "BrowserRecordingRequiresVisibleTabError",
  {
    tabId: Schema.String,
  },
) {
  override get message(): string {
    return `Browser recording requires tab ${this.tabId} to be visible.`;
  }
}

export class BrowserRecordingOperationError extends Schema.TaggedErrorClass<BrowserRecordingOperationError>()(
  "BrowserRecordingOperationError",
  {
    operation: Schema.Literals([
      "initialize-media-recorder",
      "subscribe-frames",
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

type BrowserRecordingLifecycle =
  | { readonly phase: "starting" }
  | { readonly phase: "recording" }
  | {
      readonly phase: "stopping";
      readonly stopPromise: Promise<DesktopPreviewRecordingArtifact | null>;
    };

interface ActiveRecording {
  readonly tabId: string;
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly recorder: MediaRecorder;
  readonly chunks: Blob[];
  readonly mimeType: string;
  readonly startedAt: string;
  readonly startupSettled: Promise<void>;
  lifecycle: BrowserRecordingLifecycle;
}

const activeBrowserRecordingTabIdAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("preview:active-browser-recording-tab"),
);

export function useActiveBrowserRecordingTabId(): string | null {
  return useAtomValue(activeBrowserRecordingTabIdAtom);
}

let active: ActiveRecording | null = null;
let unsubscribeFrames: (() => void) | null = null;

export const BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS = 5_000;

export function readActiveBrowserRecordingTabId(): string | null {
  return active?.tabId ?? null;
}

const preferredMimeType = (): string => {
  const candidates = ["video/mp4;codecs=avc1.42E01E", "video/webm;codecs=vp9", "video/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "video/webm";
};

const drawFrame = (frame: DesktopPreviewRecordingFrame): void => {
  const recording = active;
  if (!recording || recording.tabId !== frame.tabId) return;
  const image = new Image();
  image.addEventListener(
    "load",
    () => {
      if (active !== recording) return;
      recording.context.drawImage(image, 0, 0, recording.canvas.width, recording.canvas.height);
    },
    { once: true },
  );
  image.src = `data:image/jpeg;base64,${frame.data}`;
};

const stopMediaRecorder = async (recorder: MediaRecorder): Promise<void> => {
  if (recorder.state === "inactive") return;
  const stopped = new Promise<void>((resolve) =>
    recorder.addEventListener("stop", () => resolve(), { once: true }),
  );
  recorder.stop();
  await stopped;
};

const clearActiveRecording = (recording: ActiveRecording): void => {
  if (active !== recording) return;
  active = null;
  unsubscribeFrames?.();
  unsubscribeFrames = null;
  appAtomRegistry.set(activeBrowserRecordingTabIdAtom, null);
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
  active === recording && recording.lifecycle.phase === "starting";

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

export async function startBrowserRecording(tabId: string): Promise<string> {
  const bridge = previewBridge;
  if (!bridge) throw new BrowserRecordingUnavailableError({ tabId });
  if (active) {
    if (active.tabId === tabId && active.lifecycle.phase === "recording") {
      return active.startedAt;
    }
    throw new BrowserRecordingConflictError({
      requestedTabId: tabId,
      activeTabId: active.tabId,
    });
  }
  const surface = useBrowserSurfaceStore.getState().byTabId[tabId];
  if (!surface?.visible) throw new BrowserRecordingRequiresVisibleTabError({ tabId });
  const recordingSize = surface?.content ?? surface?.rect;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, recordingSize?.width ?? 1280);
  canvas.height = Math.max(1, recordingSize?.height ?? 800);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new BrowserRecordingCanvasUnavailableError({
      tabId,
      width: canvas.width,
      height: canvas.height,
    });
  }
  let mimeType: string;
  let recorder: MediaRecorder;
  try {
    mimeType = preferredMimeType();
    recorder = new MediaRecorder(canvas.captureStream(12), {
      mimeType,
      videoBitsPerSecond: 4_000_000,
    });
  } catch (cause) {
    throw new BrowserRecordingOperationError({
      operation: "initialize-media-recorder",
      tabId,
      cause,
    });
  }
  const startedAt = new Date().toISOString();
  const chunks: Blob[] = [];
  let settleStartup: (() => void) | undefined;
  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const recording: ActiveRecording = {
    tabId,
    canvas,
    context,
    recorder,
    chunks,
    mimeType,
    startedAt,
    startupSettled,
    lifecycle: { phase: "starting" },
  };
  active = recording;
  try {
    try {
      unsubscribeFrames ??= bridge.recording.onFrame(drawFrame);
    } catch (cause) {
      clearActiveRecording(recording);
      throw new BrowserRecordingOperationError({
        operation: "subscribe-frames",
        tabId,
        cause,
      });
    }
    try {
      recorder.start(1_000);
    } catch (cause) {
      clearActiveRecording(recording);
      throw new BrowserRecordingOperationError({
        operation: "start-media-recorder",
        tabId,
        cause,
      });
    }
    if (!isRecordingStarting(recording)) {
      throw recordingStartupCancelledError(recording);
    }
    try {
      await bridge.recording.startScreencast(tabId);
    } catch (cause) {
      if (!isRecordingStarting(recording)) {
        throw recordingStartupCancelledError(recording, cause);
      }
      let cleanupCause: unknown;
      try {
        await stopMediaRecorder(recorder);
      } catch (error) {
        cleanupCause = error;
      } finally {
        clearActiveRecording(recording);
      }
      throw new BrowserRecordingOperationError({
        operation: "start-screencast",
        tabId,
        cause:
          cleanupCause === undefined
            ? cause
            : new AggregateError(
                [cause, cleanupCause],
                `Browser recording start and cleanup failed for tab ${tabId}.`,
                { cause },
              ),
      });
    }
    if (!isRecordingStarting(recording)) {
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
    }
    recording.lifecycle = { phase: "recording" };
    appAtomRegistry.set(activeBrowserRecordingTabIdAtom, tabId);
    return startedAt;
  } finally {
    settleStartup?.();
  }
}

const finalizeBrowserRecording = async (
  bridge: NonNullable<typeof previewBridge>,
  recording: ActiveRecording,
): Promise<DesktopPreviewRecordingArtifact> => {
  const { tabId } = recording;
  let result:
    | { readonly _tag: "Success"; readonly artifact: DesktopPreviewRecordingArtifact }
    | { readonly _tag: "Failure"; readonly error: unknown };
  try {
    try {
      await bridge.recording.stopScreencast(tabId);
    } catch (cause) {
      throw new BrowserRecordingOperationError({
        operation: "stop-screencast",
        tabId,
        cause,
      });
    }
    await waitForRecordingStartupToSettle(recording);
    try {
      await stopMediaRecorder(recording.recorder);
    } catch (cause) {
      throw new BrowserRecordingOperationError({
        operation: "stop-media-recorder",
        tabId,
        cause,
      });
    }
    try {
      const blob = new Blob(recording.chunks, { type: recording.mimeType });
      const artifact = await bridge.recording.save(
        tabId,
        recording.mimeType,
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

  let cleanupError: BrowserRecordingOperationError | undefined;
  try {
    await stopMediaRecorder(recording.recorder);
  } catch (cause) {
    cleanupError = new BrowserRecordingOperationError({
      operation: "stop-media-recorder",
      tabId,
      cause,
    });
  } finally {
    clearActiveRecording(recording);
  }

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
    return null;
  } finally {
    clearActiveRecording(recording);
  }
};

export function stopBrowserRecording(
  tabId: string,
): Promise<DesktopPreviewRecordingArtifact | null> {
  const bridge = previewBridge;
  const recording = active;
  if (!bridge || !recording || recording.tabId !== tabId) return Promise.resolve(null);
  if (recording.lifecycle.phase === "stopping") return recording.lifecycle.stopPromise;

  const stopPromise = Promise.resolve()
    .then(() => finalizeBrowserRecording(bridge, recording))
    .catch((error) => {
      if (isStartupWaitTimeout(error) && active === recording) {
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
