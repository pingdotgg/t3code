import {
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ensureClientSettingsHydrated } from "~/hooks/useSettings";

const {
  clientSettings,
  events,
  getUserMedia,
  onFrame,
  registrySet,
  requestTabMediaCapture,
  save,
  startScreencast,
  stopScreencast,
} = vi.hoisted(() => {
  const events: string[] = [];
  return {
    clientSettings: { browserRecordingFrameRate: 30 as 30 | 60 },
    events,
    getUserMedia: vi.fn(),
    onFrame: vi.fn(),
    requestTabMediaCapture: vi.fn((_tabId: string): void | Promise<void> => undefined),
    registrySet: vi.fn((_atom: unknown, value: { readonly tabIds: ReadonlySet<string> }) => {
      events.push(
        value.tabIds.size === 0 ? "clear" : `publish:${Array.from(value.tabIds).join(",")}`,
      );
    }),
    save: vi.fn(async (tabId: string) => ({
      id: "recording-test",
      tabId,
      path: "/tmp/recording-test.webm",
      mimeType: "video/webm" as const,
      sizeBytes: 0,
      createdAt: "2026-06-26T00:00:00.000Z",
    })),
    startScreencast: vi.fn(async (_tabId: string) => {
      events.push("start-screencast");
    }),
    stopScreencast: vi.fn(async () => undefined),
  };
});

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    recording: {
      onFrame,
      save,
      startScreencast: async (tabId: string) => {
        await startScreencast(tabId);
        await requestTabMediaCapture(tabId);
      },
      stopScreencast,
    },
  },
}));

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { set: registrySet },
}));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
  getClientSettings: () => clientSettings,
}));

import {
  BROWSER_RECORDING_PAINT_SETTLE_TIMEOUT_MS,
  BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
  BrowserRecordingCaptureTimeoutError,
  BrowserRecordingConflictError,
  BrowserRecordingFormatUnavailableError,
  findActiveBrowserRecordingRuntimeTabId,
  readActiveBrowserRecordingTabIds,
  readActiveBrowserRecordingTargets,
  startBrowserRecording,
  stopBrowserRecording,
  stopBrowserRecordingForUpload,
} from "./browserRecording";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

class FakeMediaRecorder {
  static readonly instances: FakeMediaRecorder[] = [];
  static supportedTypes = new Set(["video/webm;codecs=vp9"]);
  static outputMimeType: string | undefined;
  static stopError: unknown;
  static isTypeSupported(type: string): boolean {
    return this.supportedTypes.has(type);
  }

  state: RecordingState = "inactive";
  readonly mimeType: string;
  readonly stream: MediaStream;
  readonly options: MediaRecorderOptions | undefined;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream;
    this.options = options;
    this.mimeType =
      FakeMediaRecorder.outputMimeType ?? options?.mimeType ?? "video/browser-default";
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    if (FakeMediaRecorder.stopError !== undefined) throw FakeMediaRecorder.stopError;
    this.state = "inactive";
    for (const listener of this.listeners.get("stop") ?? []) {
      if (typeof listener === "function") listener(new Event("stop"));
      else listener.handleEvent(new Event("stop"));
    }
  }
}

describe("browser recording", () => {
  let animationFrameCount = 0;

  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
    FakeMediaRecorder.instances.length = 0;
    FakeMediaRecorder.supportedTypes = new Set(["video/webm;codecs=vp9"]);
    FakeMediaRecorder.outputMimeType = undefined;
    FakeMediaRecorder.stopError = undefined;
    clientSettings.browserRecordingFrameRate = 30;
    animationFrameCount = 0;
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrameCount += 1;
      callback(animationFrameCount);
      return animationFrameCount;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);
    getUserMedia.mockResolvedValue({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: vi.fn() }],
    });
    requestTabMediaCapture.mockImplementation(async (tabId: string) => {
      const trigger = Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER);
      if (typeof trigger !== "function") {
        throw new Error(`No pending tab capture for ${tabId}.`);
      }
      const result = await trigger(tabId, `tab-source:${tabId}`, { width: 1280, height: 720 });
      if (result !== true && result?.mode !== "frame-subscription")
        throw new Error(`No pending tab capture for ${tabId}.`);
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts recording for a visible tab", async () => {
    await startBrowserRecording("recording-tab");
    const startupEvents = [...events];

    await stopBrowserRecording("recording-tab");
    expect(startupEvents).toEqual(["publish:recording-tab", "start-screencast"]);
  });

  it("routes gesture-free starts through the desktop capture trigger", async () => {
    await startBrowserRecording("automation-recording-tab");

    expect(requestTabMediaCapture).toHaveBeenCalledWith("automation-recording-tab");
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(onFrame).not.toHaveBeenCalled();
    await stopBrowserRecording("automation-recording-tab");
  });

  const prepareFrameFallback = () => {
    let captureId!: string;
    let captured!: () => void;
    const ready = new Promise<void>((resolve) => (captured = resolve));
    const trigger = Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER);
    requestTabMediaCapture.mockImplementation(async (tabId: string) => {
      const result = await trigger(tabId, `tab-source:${tabId}`, { width: 1280, height: 720 });
      if (result?.mode !== "frame-subscription") throw new Error("No page capture requested");
      captureId = result.captureId;
      captured();
    });
    const stop = vi.fn();
    const requestFrame = vi.fn();
    const track = {
      stop,
      requestFrame,
      getSettings: () => ({ width: 1280, height: 720, frameRate: 0 }),
    };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      captureStream: vi.fn(() => stream),
    };
    const bitmap = { close: vi.fn() };
    const decode = vi.fn(async () => bitmap);
    vi.stubGlobal("document", { createElement: () => canvas });
    vi.stubGlobal("createImageBitmap", decode);
    getUserMedia.mockRejectedValueOnce(
      new DOMException("Could not start video source", "NotReadableError"),
    );
    return {
      ready,
      receive: (tabId = "recording-tab", sourceVersion = 0) =>
        trigger.frame(
          tabId,
          captureId,
          {
            tabId,
            data: btoa("owned page pixels"),
            width: 1280,
            height: 720,
            receivedAt: "2026-10-07T10:00:00.000Z",
          },
          sourceVersion,
        ),
      get captureId() {
        return captureId;
      },
      stop,
      requestFrame,
      stream,
      canvas,
      drawImage,
      bitmap,
      decode,
    };
  };

  it("records the same guest's frames when native tab acquisition is unreadable", async () => {
    const frames = prepareFrameFallback();
    const started = startBrowserRecording("recording-tab");
    await frames.ready;
    frames.receive("other-tab");
    expect(frames.decode).not.toHaveBeenCalled();
    frames.receive();
    await started;
    expect(FakeMediaRecorder.instances[0]?.stream).toBe(frames.stream);
    expect(frames.drawImage).toHaveBeenCalledWith(frames.bitmap, 0, 0, 1280, 720);
    expect(frames.requestFrame).toHaveBeenCalledOnce();
    expect(frames.bitmap.close).toHaveBeenCalledOnce();
    await stopBrowserRecording("recording-tab");
    expect(frames.stop).toHaveBeenCalledOnce();
    expect(onFrame).not.toHaveBeenCalled();
    frames.receive();
    expect(frames.decode).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it("does not substitute page frames for a denied native capture", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    await expect(startBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "capture-media-stream",
    });
    expect(onFrame).not.toHaveBeenCalled();
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it("releases a canvas stream whose first frame cannot be requested", async () => {
    const frames = prepareFrameFallback();
    frames.requestFrame.mockImplementationOnce(() => {
      throw new Error("Canvas frame unavailable");
    });
    const started = startBrowserRecording("recording-tab");
    const failed = expect(started).rejects.toMatchObject({ operation: "capture-media-stream" });
    await frames.ready;
    frames.receive();
    await failed;
    expect(frames.stop).toHaveBeenCalledOnce();
    expect(onFrame).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it("rejects later frames immediately after initial decode failure during native cleanup", async () => {
    const frames = prepareFrameFallback();
    let releaseCleanup!: () => void;
    let enteredCleanup!: () => void;
    const cleaning = new Promise<void>((resolve) => (enteredCleanup = resolve));
    stopScreencast.mockImplementationOnce(() => {
      enteredCleanup();
      return new Promise<undefined>((resolve) => (releaseCleanup = () => resolve(undefined)));
    });
    frames.decode.mockRejectedValueOnce(new Error("First decode failed"));
    const started = startBrowserRecording("recording-tab");
    const failed = expect(started).rejects.toMatchObject({ operation: "capture-media-stream" });
    await frames.ready;
    frames.receive();
    await cleaning;
    expect(onFrame).not.toHaveBeenCalled();
    frames.receive();
    expect(frames.decode).toHaveBeenCalledOnce();
    expect(frames.canvas.captureStream).not.toHaveBeenCalled();
    releaseCleanup();
    await failed;
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it("consumes the latest final frame after a blocked decode without another page update", async () => {
    vi.useFakeTimers();
    const frames = prepareFrameFallback();
    let finishDecode!: (bitmap: typeof frames.bitmap) => void;
    frames.decode.mockImplementationOnce(() => new Promise((resolve) => (finishDecode = resolve)));
    const started = startBrowserRecording("recording-tab");
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_PAINT_SETTLE_TIMEOUT_MS);
    await frames.ready;
    frames.receive();
    frames.receive();
    frames.receive();
    expect(frames.decode).toHaveBeenCalledOnce();
    finishDecode(frames.bitmap);
    await vi.advanceTimersByTimeAsync(0);
    await started;
    await vi.advanceTimersByTimeAsync(34);
    expect(frames.decode).toHaveBeenCalledTimes(2);
    expect(frames.drawImage).toHaveBeenCalledTimes(2);
    expect(frames.requestFrame).toHaveBeenCalledTimes(2);
    await stopBrowserRecording("recording-tab");
    expect(frames.stop).toHaveBeenCalledOnce();
  });

  it("discards a late decoded old guest frame when the authoritative source changes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes });
    const frames = prepareFrameFallback();
    let finishDecode!: (bitmap: typeof frames.bitmap) => void;
    const oldBitmap = { close: vi.fn() };
    frames.decode.mockImplementationOnce(() => new Promise((resolve) => (finishDecode = resolve)));
    const started = startBrowserRecording("recording-tab");
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_PAINT_SETTLE_TIMEOUT_MS);
    await frames.ready;
    frames.receive();
    const trigger = Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER);
    const captureId = "00000000-0000-4000-8000-000000000000";
    expect(trigger.source("recording-tab", captureId, 1)).toBe(true);
    frames.receive("recording-tab", 1);
    expect(
      await trigger.frame(
        "recording-tab",
        captureId,
        {
          tabId: "recording-tab",
          data: btoa("stale"),
          width: 1280,
          height: 720,
          receivedAt: "2026-10-07T10:00:00.000Z",
        },
        0,
      ),
    ).toBe(false);
    finishDecode(oldBitmap);
    await vi.advanceTimersByTimeAsync(34);
    await started;
    expect(oldBitmap.close).toHaveBeenCalledOnce();
    expect(frames.drawImage).toHaveBeenCalledOnce();
    expect(frames.drawImage).toHaveBeenCalledWith(frames.bitmap, 0, 0, 1280, 720);
    expect(frames.requestFrame).toHaveBeenCalledOnce();
    await stopBrowserRecording("recording-tab");
    expect(trigger.source("recording-tab", captureId, 2)).toBe(false);
  });

  it.each([true, false])(
    "keeps replacement startup when an obsolete decode rejects, replacement queued=%s",
    async (queued) => {
      vi.useFakeTimers();
      const frames = prepareFrameFallback();
      let rejectDecode!: (cause: unknown) => void;
      frames.decode.mockImplementationOnce(
        () => new Promise((_, reject) => (rejectDecode = reject)),
      );
      const started = startBrowserRecording("recording-tab");
      await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_PAINT_SETTLE_TIMEOUT_MS);
      await frames.ready;
      frames.receive();
      const trigger = Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER);
      expect(trigger.source("recording-tab", frames.captureId, 1)).toBe(true);
      if (queued) frames.receive("recording-tab", 1);
      rejectDecode(new Error("Obsolete source decode failed"));
      await vi.advanceTimersByTimeAsync(0);
      if (!queued) frames.receive("recording-tab", 1);
      await vi.advanceTimersByTimeAsync(34);
      await started;
      expect(frames.drawImage).toHaveBeenCalledOnce();
      expect(frames.requestFrame).toHaveBeenCalledOnce();
      expect(FakeMediaRecorder.instances[0]?.stream).toBe(frames.stream);
      await stopBrowserRecording("recording-tab");
      expect(frames.stop).toHaveBeenCalledOnce();
    },
  );

  it("ends only the matching fallback and joins production stop after source failure", async () => {
    const frames = prepareFrameFallback();
    const started = startBrowserRecording("recording-tab");
    await frames.ready;
    frames.receive();
    await started;
    let finishNativeStop!: () => void;
    let enteredNativeStop!: () => void;
    const stopping = new Promise<void>((resolve) => (enteredNativeStop = resolve));
    stopScreencast.mockImplementationOnce(() => {
      enteredNativeStop();
      return new Promise<undefined>((resolve) => (finishNativeStop = () => resolve(undefined)));
    });
    const trigger = Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER);
    expect(trigger.end("recording-tab", "obsolete-capture")).toBe(false);
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set(["recording-tab"]));
    expect(trigger.end("recording-tab", frames.captureId)).toBe(true);
    expect(await frames.receive()).toBe(false);
    const ended = stopBrowserRecording("recording-tab");
    await stopping;
    expect(frames.drawImage).toHaveBeenCalledOnce();
    finishNativeStop();
    await ended;
    expect(FakeMediaRecorder.instances[0]?.state).toBe("inactive");
    expect(frames.stop).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
    expect(useBrowserSurfaceStore.getState().activityByTabId["recording-tab"]).toBeUndefined();

    const replacement = prepareFrameFallback();
    const restarted = startBrowserRecording("recording-tab");
    await replacement.ready;
    replacement.receive();
    await restarted;
    expect(trigger.end("recording-tab", frames.captureId)).toBe(false);
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set(["recording-tab"]));
    expect(replacement.stop).not.toHaveBeenCalled();
    await stopBrowserRecording("recording-tab");
  });

  it("acknowledges private consumption and rejects a different capture identity", async () => {
    const frames = prepareFrameFallback();
    let finishDecode!: (bitmap: typeof frames.bitmap) => void;
    frames.decode.mockImplementationOnce(() => new Promise((resolve) => (finishDecode = resolve)));
    const started = startBrowserRecording("recording-tab");
    await frames.ready;
    const trigger = Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER);
    const frame = {
      tabId: "recording-tab",
      data: btoa("owned page pixels"),
      width: 1280,
      height: 720,
      receivedAt: "2026-10-07T10:00:00.000Z",
    };
    expect(await trigger.frame("recording-tab", "obsolete-capture", frame, 0)).toBe(false);
    expect(frames.decode).not.toHaveBeenCalled();
    const consumed = frames.receive();
    const acknowledged = vi.fn();
    void consumed.then(acknowledged);
    expect(acknowledged).not.toHaveBeenCalled();
    finishDecode(frames.bitmap);
    expect(await consumed).toBe(true);
    await started;
    expect(frames.drawImage).toHaveBeenCalledOnce();
    expect(acknowledged).toHaveBeenCalledWith(true);
    expect(onFrame).not.toHaveBeenCalled();
    await stopBrowserRecording("recording-tab");
  });

  it("keeps one acquisition deadline when native failure falls back to page frames", async () => {
    vi.useFakeTimers();
    const frames = prepareFrameFallback();
    let failNative!: (cause: unknown) => void;
    getUserMedia.mockReset();
    getUserMedia.mockImplementationOnce(() => new Promise((_, reject) => (failNative = reject)));
    const started = startBrowserRecording("recording-tab");
    const failed = expect(started).rejects.toMatchObject({
      _tag: "BrowserRecordingCaptureTimeoutError",
    });
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_PAINT_SETTLE_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(3_500);
    failNative(new DOMException("Could not start video source", "NotReadableError"));
    await frames.ready;
    await vi.advanceTimersByTimeAsync(1_500);
    await failed;
    expect(onFrame).not.toHaveBeenCalled();
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it("drops concurrent frames and closes a late bitmap after fallback startup times out", async () => {
    vi.useFakeTimers();
    const frames = prepareFrameFallback();
    let finishDecode!: (bitmap: typeof frames.bitmap) => void;
    frames.decode.mockImplementationOnce(() => new Promise((resolve) => (finishDecode = resolve)));
    const started = startBrowserRecording("recording-tab");
    const failed = expect(started).rejects.toMatchObject({
      _tag: "BrowserRecordingCaptureTimeoutError",
    });
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_PAINT_SETTLE_TIMEOUT_MS);
    await frames.ready;
    frames.receive();
    frames.receive();
    expect(frames.decode).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS);
    await failed;
    expect(onFrame).not.toHaveBeenCalled();
    finishDecode(frames.bitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.bitmap.close).toHaveBeenCalledOnce();
    expect(frames.canvas.captureStream).not.toHaveBeenCalled();
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it("saves locally and releases capture before transferring the encoded recording once", async () => {
    const stopTrack = vi.fn();
    getUserMedia.mockResolvedValue({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: stopTrack }],
    });
    await startBrowserRecording("transfer-tab");
    let finishUpload!: () => void;
    const uploaded = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    const transfer = vi.fn(async (artifact, blob: Blob) => {
      expect(save).toHaveBeenCalledOnce();
      expect(stopTrack).toHaveBeenCalled();
      expect(artifact.path).toBe("/tmp/recording-test.webm");
      expect(blob.type).toBe("video/webm;codecs=vp9");
      await uploaded;
      return "uploaded-recording";
    });
    const localStop = stopBrowserRecording("transfer-tab");
    const firstStop = stopBrowserRecordingForUpload("transfer-tab", transfer);
    const secondStop = stopBrowserRecordingForUpload("transfer-tab", transfer);
    finishUpload();
    expect(await firstStop).toEqual(await secondStop);
    expect((await firstStop)?.uploadedAttachmentId).toBe("uploaded-recording");
    expect((await localStop)?.path).toBe("/tmp/recording-test.webm");
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("keeps the saved desktop file and releases the recording when transfer fails", async () => {
    await startBrowserRecording("failed-transfer-tab");
    await expect(
      stopBrowserRecordingForUpload("failed-transfer-tab", async () => {
        throw new Error("Connection interrupted");
      }),
    ).rejects.toThrow("Connection interrupted");
    expect(save).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds().has("failed-transfer-tab")).toBe(false);
    await startBrowserRecording("failed-transfer-tab");
    await stopBrowserRecording("failed-transfer-tab");
  });

  it("paints and holds a hidden browser surface for the recording lifetime", async () => {
    startScreencast.mockImplementationOnce(async (tabId: string) => {
      expect(animationFrameCount).toBe(2);
      expect(useBrowserSurfaceStore.getState().activityByTabId[tabId]).toBe(1);
    });
    getUserMedia.mockImplementationOnce(async () => {
      expect(animationFrameCount).toBe(2);
      expect(useBrowserSurfaceStore.getState().activityByTabId["background-tab"]).toBe(1);
      return { getVideoTracks: () => [], getTracks: () => [{ stop: vi.fn() }] };
    });

    await startBrowserRecording("background-tab");
    expect(useBrowserSurfaceStore.getState().activityByTabId["background-tab"]).toBe(1);

    await stopBrowserRecording("background-tab");
    expect(useBrowserSurfaceStore.getState().activityByTabId["background-tab"]).toBeUndefined();
  });

  it("bounds compositor warmup when animation frames are paused", async () => {
    vi.useFakeTimers();
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 42),
    );
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const startPromise = startBrowserRecording("hidden-window-tab");
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_PAINT_SETTLE_TIMEOUT_MS);

    await startPromise;
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
    await stopBrowserRecording("hidden-window-tab");
  });

  it.each([
    { width: 1280, height: 720, frameRate: 60, bitrate: 2_764_800 },
    { width: 320, height: 240, frameRate: 30, bitrate: 2_500_000 },
    { width: 3840, height: 2160, frameRate: 60, bitrate: 24_883_200 },
    { width: 7680, height: 4320, frameRate: 60, bitrate: 50_000_000 },
  ])("records the native $width x $height stream at $frameRate fps", async (settings) => {
    const stopTrack = vi.fn();
    const stream = {
      getVideoTracks: () => [{ getSettings: () => settings }],
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    getUserMedia.mockResolvedValueOnce(stream);

    await startBrowserRecording("recording-tab");

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: "tab-source:recording-tab",
          minWidth: 1280,
          maxWidth: 1280,
          minHeight: 720,
          maxHeight: 720,
          maxFrameRate: 30,
        },
      },
    });
    expect(FakeMediaRecorder.instances[0]?.stream).toBe(stream);
    expect(FakeMediaRecorder.instances[0]?.options?.videoBitsPerSecond).toBe(settings.bitrate);

    await stopBrowserRecording("recording-tab");
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(stopTrack.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0]!);
  });

  it("uses the configured recording frame rate", async () => {
    clientSettings.browserRecordingFrameRate = 60;

    await startBrowserRecording("recording-tab");

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: expect.stringMatching(/^tab-source:/),
          minWidth: 1280,
          maxWidth: 1280,
          minHeight: 720,
          maxHeight: 720,
          maxFrameRate: 60,
        },
      },
    });
    await stopBrowserRecording("recording-tab");
  });

  it("clears a failed settings read before retrying recording", async () => {
    const tabId = "settings-read-failure-tab";
    const error = new Error("Settings read failed");
    vi.mocked(ensureClientSettingsHydrated).mockRejectedValueOnce(error);

    await expect(startBrowserRecording(tabId)).rejects.toBe(error);

    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
    expect(useBrowserSurfaceStore.getState().activityByTabId[tabId]).toBeUndefined();
    expect(animationFrameCount).toBe(0);
    expect(startScreencast).not.toHaveBeenCalled();
    expect(stopScreencast).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);

    clientSettings.browserRecordingFrameRate = 60;
    await startBrowserRecording(tabId);

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: expect.stringMatching(/^tab-source:/),
          minWidth: 1280,
          maxWidth: 1280,
          minHeight: 720,
          maxHeight: 720,
          maxFrameRate: 60,
        },
      },
    });
    await stopBrowserRecording(tabId);

    expect(startScreencast).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
    expect(useBrowserSurfaceStore.getState().activityByTabId[tabId]).toBeUndefined();
  });

  it("stops the native stream when MediaRecorder cleanup fails", async () => {
    const stopTrack = vi.fn();
    getUserMedia.mockResolvedValueOnce({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: stopTrack }],
    });

    await startBrowserRecording("recording-tab");
    FakeMediaRecorder.stopError = new Error("stop failed");

    await expect(stopBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "cleanup",
      tabId: "recording-tab",
    });
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("uses the best supported encoder and saves the recorder's actual format", async () => {
    FakeMediaRecorder.supportedTypes = new Set([
      "video/mp4;codecs=avc1",
      "video/mp4;codecs=avc1.42e01e",
      "video/webm;codecs=vp9",
      "video/webm;codecs=av1",
    ]);
    FakeMediaRecorder.outputMimeType = "video/webm;codecs=av01";

    await startBrowserRecording("recording-tab");
    await stopBrowserRecording("recording-tab");

    expect(FakeMediaRecorder.instances[0]?.options).toEqual({
      mimeType: "video/mp4;codecs=avc1",
      videoBitsPerSecond: 3_110_400,
    });
    expect(save).toHaveBeenCalledWith(
      "recording-tab",
      "video/webm;codecs=av01",
      expect.any(Uint8Array),
    );
  });

  it("lets the browser select the format when no preferred encoding is supported", async () => {
    FakeMediaRecorder.supportedTypes = new Set();
    FakeMediaRecorder.outputMimeType = "video/platform-default";

    await startBrowserRecording("recording-tab");
    await stopBrowserRecording("recording-tab");

    expect(FakeMediaRecorder.instances[0]?.options).toEqual({ videoBitsPerSecond: 3_110_400 });
    expect(save).toHaveBeenCalledWith(
      "recording-tab",
      "video/platform-default",
      expect.any(Uint8Array),
    );
  });

  it("reports when MediaRecorder provides no output format", async () => {
    FakeMediaRecorder.supportedTypes = new Set();
    FakeMediaRecorder.outputMimeType = "";

    await startBrowserRecording("recording-tab");

    await expect(stopBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingFormatUnavailableError,
    );
    expect(save).not.toHaveBeenCalled();
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it("releases the native capture lease when stream acquisition fails", async () => {
    getUserMedia.mockRejectedValueOnce(new Error("capture failed"));

    await expect(startBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "capture-media-stream",
      tabId: "recording-tab",
    });

    expect(stopScreencast).toHaveBeenCalledWith("recording-tab");
    expect(events.at(-1)).toBe("clear");
  });

  it("times out stalled stream acquisition and stops a late stream", async () => {
    vi.useFakeTimers();
    let finishCapture!: (stream: MediaStream) => void;
    const stopTrack = vi.fn();
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          finishCapture = resolve;
        }),
    );

    const startPromise = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    const rejection = expect(startPromise).rejects.toMatchObject({
      _tag: "BrowserRecordingCaptureTimeoutError",
      tabId: "recording-tab",
      timeoutMs: BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
    });
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS);

    await rejection;
    await expect(startPromise).rejects.toBeInstanceOf(BrowserRecordingCaptureTimeoutError);
    expect(stopScreencast).toHaveBeenCalledWith("recording-tab");
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
    expect(useBrowserSurfaceStore.getState().activityByTabId["recording-tab"]).toBeUndefined();

    finishCapture({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("records separate tabs concurrently", async () => {
    const firstThreadRef = {
      environmentId: EnvironmentId.make("environment-recording"),
      threadId: ThreadId.make("thread-recording-first"),
    };
    const secondThreadRef = {
      environmentId: EnvironmentId.make("environment-recording"),
      threadId: ThreadId.make("thread-recording-second"),
    };
    await Promise.all([
      startBrowserRecording("recording-tab", firstThreadRef),
      startBrowserRecording("recording-tab-2", secondThreadRef),
    ]);

    expect(startScreencast).toHaveBeenCalledTimes(2);
    expect(events).toContain("publish:recording-tab,recording-tab-2");
    expect(readActiveBrowserRecordingTabIds()).toEqual(
      new Set(["recording-tab", "recording-tab-2"]),
    );
    expect(readActiveBrowserRecordingTabIds(firstThreadRef)).toEqual(new Set(["recording-tab"]));
    expect(readActiveBrowserRecordingTabIds(secondThreadRef)).toEqual(new Set(["recording-tab-2"]));

    await stopBrowserRecording("recording-tab");
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set(["recording-tab-2"]));
    await stopBrowserRecording("recording-tab-2");
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("starts and stops another tab while an independent acquisition is stalled", async () => {
    let finishFirstCapture!: (stream: MediaStream) => void;
    const firstTrackStop = vi.fn();
    const secondTrackStop = vi.fn();
    getUserMedia
      .mockImplementationOnce(
        () =>
          new Promise<MediaStream>((resolve) => {
            finishFirstCapture = resolve;
          }),
      )
      .mockResolvedValueOnce({
        getVideoTracks: () => [],
        getTracks: () => [{ stop: secondTrackStop }],
      });

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    await startBrowserRecording("recording-tab-2");
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await expect(stopBrowserRecording("recording-tab-2")).resolves.toMatchObject({
      tabId: "recording-tab-2",
    });
    expect(secondTrackStop).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set(["recording-tab"]));

    const firstStop = stopBrowserRecording("recording-tab");
    finishFirstCapture({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: firstTrackStop }],
    } as unknown as MediaStream);
    await firstStart;
    await expect(firstStop).resolves.toMatchObject({ tabId: "recording-tab" });
    expect(firstTrackStop).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it("finishes startup before stopping when stop arrives during paint", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      }),
    );

    const startPromise = startBrowserRecording("recording-tab");
    await vi.waitFor(() =>
      expect(readActiveBrowserRecordingTabIds().has("recording-tab")).toBe(true),
    );
    const stopPromise = stopBrowserRecording("recording-tab");
    expect(startScreencast).not.toHaveBeenCalled();

    animationFrames.shift()?.(1);
    animationFrames.shift()?.(2);
    await startPromise;
    await expect(stopPromise).resolves.toMatchObject({ tabId: "recording-tab" });
  });

  it("keeps a recording reachable through its runtime id after a server epoch changes", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-recording"),
      threadId: ThreadId.make("thread-recording-scoped"),
    };
    const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-a", "tab_1");
    await startBrowserRecording(runtimeTabId, threadRef, "tab_1");

    expect(startScreencast).toHaveBeenCalledWith(runtimeTabId);
    expect(readActiveBrowserRecordingTabIds(threadRef)).toEqual(new Set([runtimeTabId]));
    expect(readActiveBrowserRecordingTargets(threadRef)).toEqual([
      { runtimeTabId, serverTabId: "tab_1" },
    ]);
    expect(findActiveBrowserRecordingRuntimeTabId(threadRef, "tab_1")).toBe(runtimeTabId);

    const replacementRuntimeTabId = previewRuntimeTabId(threadRef, "epoch-b", "tab_1");
    await expect(
      startBrowserRecording(replacementRuntimeTabId, threadRef, "tab_1"),
    ).rejects.toBeInstanceOf(BrowserRecordingConflictError);
    expect(startScreencast).toHaveBeenCalledTimes(1);

    await stopBrowserRecording(runtimeTabId);
  });

  it("does not report success for a second start while the first is still starting", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStartingScreencast?.();
    await firstStart;
    await stopBrowserRecording("recording-tab");
  });

  it("does not report success for a start while the recording is stopping", async () => {
    let finishStoppingScreencast: (() => void) | undefined;
    stopScreencast.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishStoppingScreencast = resolve;
      });
      return undefined;
    });

    await startBrowserRecording("recording-tab");
    const stopPromise = stopBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce());

    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStoppingScreencast?.();
    await stopPromise;
  });

  it("shares an in-progress stop with duplicate callers", async () => {
    let finishStoppingScreencast: (() => void) | undefined;
    stopScreencast.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishStoppingScreencast = resolve;
      });
      return undefined;
    });

    await startBrowserRecording("recording-tab");
    const firstStop = stopBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce());
    const duplicateStop = stopBrowserRecording("recording-tab");

    finishStoppingScreencast?.();
    const [firstArtifact, duplicateArtifact] = await Promise.all([firstStop, duplicateStop]);

    expect(duplicateArtifact).toEqual(firstArtifact);
    expect(stopScreencast).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("finishes startup before stopping so an active recording yields an artifact", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const startPromise = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    expect(stopScreencast).not.toHaveBeenCalled();
    finishStartingScreencast?.();

    await startPromise;
    await expect(stopPromise).resolves.toMatchObject({ tabId: "recording-tab" });
    expect(stopScreencast).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(events.at(-1)).toBe("clear");
  });

  it("does not release the recording slot until a cancelled start settles", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    const restartAfterStop = stopPromise.then(() => startBrowserRecording("recording-tab"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startCallsBeforeFirstSettled = startScreencast.mock.calls.length;

    finishStartingScreencast?.();
    await firstStart;
    await stopPromise;
    await restartAfterStop;
    await stopBrowserRecording("recording-tab");

    expect(startCallsBeforeFirstSettled).toBe(1);
  });

  it("keeps the recording slot while a failed stop waits for startup", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });
    stopScreencast.mockRejectedValueOnce(new Error("initial stop failed"));

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    const rejectedStop = expect(stopPromise).rejects.toMatchObject({
      operation: "stop-screencast",
      tabId: "recording-tab",
    });
    expect(stopScreencast).not.toHaveBeenCalled();
    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStartingScreencast?.();
    await firstStart;
    await rejectedStop;
    expect(stopScreencast).toHaveBeenCalledOnce();

    await startBrowserRecording("recording-tab");
    await stopBrowserRecording("recording-tab");
  });

  it("fails a stop that waits too long for startup without freeing the recording slot", async () => {
    vi.useFakeTimers();
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const startPromise = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    await vi.advanceTimersByTimeAsync(0);
    expect(stopScreencast).not.toHaveBeenCalled();

    const rejection = expect(stopPromise).rejects.toMatchObject({
      operation: "wait-startup",
      tabId: "recording-tab",
    });
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS);

    await rejection;
    expect(save).not.toHaveBeenCalled();
    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStartingScreencast?.();
    await vi.advanceTimersByTimeAsync(32);
    await startPromise;
    const cleanupResult = await stopBrowserRecording("recording-tab");
    expect(cleanupResult).toBeNull();
    expect(stopScreencast).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe("clear");
  });
});
