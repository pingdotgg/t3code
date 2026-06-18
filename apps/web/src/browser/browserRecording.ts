import type {
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";

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
  if (!bridge) throw new Error("Browser recording is unavailable.");
  if (active) {
    if (active.tabId === tabId) return active.startedAt;
    throw new Error("Another preview tab is already being recorded.");
  }
  const rect = useBrowserSurfaceStore.getState().byTabId[tabId]?.rect;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, rect?.width ?? 1280);
  canvas.height = Math.max(1, rect?.height ?? 800);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Browser recording canvas is unavailable.");
  const mimeType = preferredMimeType();
  const recorder = new MediaRecorder(canvas.captureStream(12), {
    mimeType,
    videoBitsPerSecond: 4_000_000,
  });
  const startedAt = new Date().toISOString();
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const recording = { tabId, canvas, context, recorder, chunks, mimeType, startedAt };
  active = recording;
  unsubscribeFrames ??= bridge.recording.onFrame(drawFrame);
  recorder.start(1_000);
  try {
    await bridge.recording.startScreencast(tabId);
    appAtomRegistry.set(activeBrowserRecordingTabIdAtom, tabId);
    return startedAt;
  } catch (error) {
    await stopMediaRecorder(recorder);
    clearActiveRecording(recording);
    throw error;
  }
}

export async function stopBrowserRecording(
  tabId: string,
): Promise<DesktopPreviewRecordingArtifact | null> {
  const bridge = previewBridge;
  const recording = active;
  if (!bridge || !recording || recording.tabId !== tabId) return null;
  try {
    await bridge.recording.stopScreencast(tabId);
    await stopMediaRecorder(recording.recorder);
    const blob = new Blob(recording.chunks, { type: recording.mimeType });
    return await bridge.recording.save(
      tabId,
      recording.mimeType,
      new Uint8Array(await blob.arrayBuffer()),
    );
  } finally {
    await stopMediaRecorder(recording.recorder);
    clearActiveRecording(recording);
  }
}
