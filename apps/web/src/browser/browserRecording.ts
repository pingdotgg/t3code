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

export class BrowserRecordingOperationError extends Schema.TaggedErrorClass<BrowserRecordingOperationError>()(
  "BrowserRecordingOperationError",
  {
    operation: Schema.Literals([
      "initialize-media-recorder",
      "subscribe-frames",
      "start-media-recorder",
      "start-screencast",
      "stop-screencast",
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

interface ActiveRecording {
  readonly tabId: string;
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly recorder: MediaRecorder;
  readonly chunks: Blob[];
  readonly mimeType: string;
  readonly startedAt: string;
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

export async function startBrowserRecording(tabId: string): Promise<string> {
  const bridge = previewBridge;
  if (!bridge) throw new BrowserRecordingUnavailableError({ tabId });
  if (active) {
    if (active.tabId === tabId) return active.startedAt;
    throw new BrowserRecordingConflictError({
      requestedTabId: tabId,
      activeTabId: active.tabId,
    });
  }
  const surface = useBrowserSurfaceStore.getState().byTabId[tabId];
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
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const recording = { tabId, canvas, context, recorder, chunks, mimeType, startedAt };
  active = recording;
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
  try {
    await bridge.recording.startScreencast(tabId);
  } catch (cause) {
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
  appAtomRegistry.set(activeBrowserRecordingTabIdAtom, tabId);
  return startedAt;
}

export async function stopBrowserRecording(
  tabId: string,
): Promise<DesktopPreviewRecordingArtifact | null> {
  const bridge = previewBridge;
  const recording = active;
  if (!bridge || !recording || recording.tabId !== tabId) return null;
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
}
