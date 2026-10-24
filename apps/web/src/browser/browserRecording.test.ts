import {
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
  EnvironmentId,
  ThreadId,
  type DesktopPreviewBridge,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  captureScreenshot,
  clientSettings,
  events,
  getDisplayMedia,
  registrySet,
  requestDisplayMediaCapture,
  save,
  startScreencast,
  stopScreencast,
} = vi.hoisted(() => {
  const events: string[] = [];
  return {
    captureScreenshot: vi.fn<DesktopPreviewBridge["captureScreenshot"]>(),
    clientSettings: { browserRecordingFrameRate: 30 as 30 | 60 },
    events,
    getDisplayMedia: vi.fn(),
    requestDisplayMediaCapture: vi.fn(async (_tabId: string) => {}),
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
    startScreencast: vi.fn<DesktopPreviewBridge["recording"]["startScreencast"]>(async (_tabId) => {
      events.push("start-screencast");
    }),
    stopScreencast: vi.fn(async () => undefined),
  };
});

vi.mock(import("~/components/preview/previewBridge"), async (original) => {
  vi.stubGlobal("window", {
    desktopBridge: {
      preview: {
        captureScreenshot,
        recording: {
          onFrame: vi.fn(),
          save,
          startScreencast: async (tabId: string) => {
            const result = await startScreencast(tabId);
            if (result === undefined) requestDisplayMediaCapture(tabId);
            return result;
          },
          stopScreencast,
        },
      },
    },
  });
  try {
    return await original();
  } finally {
    vi.unstubAllGlobals();
  }
});

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { set: registrySet },
}));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
  getClientSettings: () => clientSettings,
}));

import {
  BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
  BrowserRecordingConflictError,
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
    getDisplayMedia.mockResolvedValue({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: vi.fn() }],
    });
    requestDisplayMediaCapture.mockImplementation(async (tabId: string) => {
      const trigger = Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER);
      if (typeof trigger !== "function" || (await trigger(tabId)) !== true) {
        throw new Error(`No pending display-media capture for ${tabId}.`);
      }
    });
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
    useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("saves locally and releases capture before transferring the encoded recording once", async () => {
    const stopTrack = vi.fn();
    getDisplayMedia.mockResolvedValue({
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

  it("stops the native stream when MediaRecorder cleanup fails", async () => {
    const stopTrack = vi.fn();
    getDisplayMedia.mockResolvedValueOnce({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: stopTrack }],
    });

    await startBrowserRecording("recording-tab");
    const cleanupCause = new DOMException("Could not start video source", "NotReadableError");
    FakeMediaRecorder.stopError = cleanupCause;

    await expect(stopBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "cleanup",
      tabId: "recording-tab",
      message: "Browser recording operation cleanup failed for tab recording-tab.",
    });
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it.each([
    new Error("capture failed"),
    new DOMException("denied", "NotAllowedError"),
    { name: "NotReadableError" },
  ])("preserves non-acquisition failures: %s", async (cause) => {
    getDisplayMedia.mockRejectedValueOnce(cause);

    await expect(startBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "capture-media-stream",
      tabId: "recording-tab",
      cause,
      message: "Browser recording operation capture-media-stream failed for tab recording-tab.",
    });

    expect(stopScreencast).toHaveBeenCalledWith("recording-tab");
    expect(events.at(-1)).toBe("clear");
  });

  const deferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((res) => (resolve = res));
    return { promise, resolve };
  };
  const fallback = (tabId = "fallback") => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const id = deferred<string>();
    const track = { stop: vi.fn(), requestFrame: vi.fn(), getSettings: () => ({ frameRate: 0 }) };
    const canvas = {
      getContext: () => ({ drawImage: vi.fn() }),
      captureStream: () => ({ getTracks: () => [track], getVideoTracks: () => [track] }),
    };
    const video = {
      srcObject: null,
      requestVideoFrameCallback: vi.fn((_callback: () => void) => 1),
      cancelVideoFrameCallback: vi.fn(),
      play: vi.fn(async () => video.requestVideoFrameCallback.mock.calls[0]?.[0]()),
      pause: vi.fn(),
    };
    vi.stubGlobal("document", {
      createElement: (tag: string) => (tag === "video" ? video : canvas),
    });
    const decode = vi.fn(async (_blob: Blob) => ({ width: 1280, height: 720, close: vi.fn() }));
    vi.stubGlobal("createImageBitmap", decode);
    const trigger = Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER);
    requestDisplayMediaCapture.mockImplementationOnce((tab) => trigger(tab).then(id.resolve));
    getDisplayMedia.mockRejectedValueOnce(new DOMException("unreadable", "NotReadableError"));
    return {
      request: id.promise,
      start: startBrowserRecording(tabId),
      frame: (data: string, id: string) => trigger.frame(tabId, id, btoa(data)),
      end: (id: string) => trigger.end(tabId, id),
      decode,
      video,
    };
  };
  it.each("frame timeout decode end end-timeout drain".split(" "))("STOP %s", async (mode) => {
    const f = fallback();
    const rejects = mode === "timeout" || mode === "drain";
    const request = await f.request;
    expect(await f.frame("stale", request + "old")).toBe(false);
    void f.frame("first", request);
    void f.frame("discarded", request);
    const last = f.frame("last", request);
    await f.start;
    await vi.advanceTimersByTimeAsync(67);
    expect(await last).toBe(true);
    expect(await f.decode.mock.calls[1]?.[0]?.text()).toBe("last");
    const bitmap = deferred<Awaited<ReturnType<typeof f.decode>>>();
    const close = vi.fn();
    const recorder = FakeMediaRecorder.instances[0]!;
    expect(f.end(request + "old")).toBe(false);
    if (mode.startsWith("end")) {
      expect(f.end(request)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.end(request) && f.video.srcObject).toBe(recorder.stream);
    }
    if (mode === "decode" || rejects) {
      f.decode.mockReturnValueOnce(bitmap.promise);
      void f.frame("pending", request);
      if (!rejects) vi.spyOn(recorder, "stop").mockImplementationOnce(vi.fn());
    }
    const draining = mode === "drain" ? stopBrowserRecording("fallback") : undefined;
    if (rejects) {
      bitmap.resolve(Promise.reject(new Error("decode")));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.video.srcObject).toBe(recorder.stream);
    }
    const stopped = draining ?? stopBrowserRecording("fallback");
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");
    expect(stopScreencast).not.toHaveBeenCalled();
    if (/^(frame|end|drain)$/.test(mode)) {
      f.video.requestVideoFrameCallback.mock.lastCall?.[0]();
      await stopped;
    } else {
      const failed = expect(stopped).rejects.toMatchObject({ operation: "stop-media-recorder" });
      await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS);
      if (mode === "decode") {
        bitmap.resolve({ width: 1280, height: 720, close });
        await vi.advanceTimersByTimeAsync(0);
        expect(f.video.play).not.toHaveBeenCalled();
        expect(f.video.requestVideoFrameCallback).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
        FakeMediaRecorder.prototype.stop.call(recorder);
      }
      await failed;
    }
    expect(stopScreencast).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledTimes(/^(frame|end|drain)$/.test(mode) ? 1 : 0);
    expect(f.video.srcObject).toBeNull();
    expect([recorder.state, ...readActiveBrowserRecordingTabIds()]).toEqual(["inactive"]);
  });
  it.each([false, true])("bounds fallback readiness or end: %s", async (ended) => {
    const native = deferred<MediaStream>();
    const f = fallback();
    getDisplayMedia.mockReset().mockReturnValueOnce(native.promise);
    await vi.advanceTimersByTimeAsync(4000);
    native.resolve(Promise.reject(new DOMException("unreadable", "NotReadableError")));
    const request = await f.request;
    const failed = expect(f.start).rejects.toThrow(ended ? /capture/ : /5000ms/);
    if (ended) expect(f.end(request)).toBe(true);
    await vi.advanceTimersByTimeAsync(ended ? 0 : 1000);
    expect(readActiveBrowserRecordingTabIds().size).toBe(0);
    await failed;
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
});
