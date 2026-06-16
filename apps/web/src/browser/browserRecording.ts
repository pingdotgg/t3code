import type {
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
} from "@t3tools/contracts";
import { create } from "zustand";

import { previewBridge } from "~/components/preview/previewBridge";
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

interface BrowserRecordingState {
  activeTabId: string | null;
  startedAt: string | null;
  lastArtifact: DesktopPreviewRecordingArtifact | null;
  setActive: (tabId: string | null, startedAt: string | null) => void;
  setArtifact: (artifact: DesktopPreviewRecordingArtifact) => void;
}

export const useBrowserRecordingStore = create<BrowserRecordingState>()((set) => ({
  activeTabId: null,
  startedAt: null,
  lastArtifact: null,
  setActive: (activeTabId, startedAt) => set({ activeTabId, startedAt }),
  setArtifact: (lastArtifact) => set({ lastArtifact }),
}));

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

export async function startBrowserRecording(tabId: string): Promise<void> {
  const bridge = previewBridge;
  if (!bridge || active) return;
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
  active = { tabId, canvas, context, recorder, chunks, mimeType, startedAt };
  unsubscribeFrames ??= bridge.recording.onFrame(drawFrame);
  recorder.start(1_000);
  try {
    await bridge.recording.startScreencast(tabId);
    useBrowserRecordingStore.getState().setActive(tabId, startedAt);
  } catch (error) {
    active = null;
    recorder.stop();
    throw error;
  }
}

export async function stopBrowserRecording(
  tabId: string,
): Promise<DesktopPreviewRecordingArtifact | null> {
  const bridge = previewBridge;
  const recording = active;
  if (!bridge || !recording || recording.tabId !== tabId) return null;
  await bridge.recording.stopScreencast(tabId);
  const stopped = new Promise<void>((resolve) =>
    recording.recorder.addEventListener("stop", () => resolve(), { once: true }),
  );
  recording.recorder.stop();
  await stopped;
  const blob = new Blob(recording.chunks, { type: recording.mimeType });
  const artifact = await bridge.recording.save(
    tabId,
    recording.mimeType,
    new Uint8Array(await blob.arrayBuffer()),
  );
  active = null;
  unsubscribeFrames?.();
  unsubscribeFrames = null;
  useBrowserRecordingStore.getState().setActive(null, null);
  useBrowserRecordingStore.getState().setArtifact(artifact);
  return artifact;
}
