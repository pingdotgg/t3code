import {
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
  EnvironmentId,
  PreviewAutomationRecordingDeadlineExpiredError,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ensureClientSettingsHydrated } from "~/hooks/useSettings";

const {
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
    clientSettings: { browserRecordingFrameRate: 30 as 30 | 60 },
    events,
    getDisplayMedia: vi.fn(),
    requestDisplayMediaCapture: vi.fn((_tabId: string) => undefined),
    registrySet: vi.fn((_atom: unknown, value: { readonly tabIds: ReadonlySet<string> }) => {
      events.push(
        value.tabIds.size === 0 ? "clear" : `publish:${Array.from(value.tabIds).join(",")}`,
      );
    }),
    save: vi.fn(
      async (
        tabId: string,
        _mimeType?: string,
        _data?: Uint8Array,
        _idempotencyKey?: string,
        _timeoutMs?: number,
      ) => ({
        id: "recording-test",
        tabId,
        path: "/tmp/recording-test.webm",
        mimeType: "video/webm" as const,
        sizeBytes: 0,
        createdAt: "2026-06-26T00:00:00.000Z",
      }),
    ),
    startScreencast: vi.fn(async (_tabId: string, _timeoutMs?: number) => {
      events.push("start-screencast");
    }),
    stopScreencast: vi.fn(async () => undefined),
  };
});

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    recording: {
      onFrame: vi.fn(),
      save,
      startScreencast: async (tabId: string, timeoutMs?: number) => {
        if (timeoutMs === undefined) await startScreencast(tabId);
        else await startScreencast(tabId, timeoutMs);
        requestDisplayMediaCapture(tabId);
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
  BrowserRecordingStartCancelledError,
  findActiveBrowserRecordingRuntimeTabId,
  readActiveBrowserRecordingTabIds,
  readActiveBrowserRecordingTargets,
  startBrowserRecording,
  stopBrowserRecording,
  stopBrowserRecordingForUpload,
} from "./browserRecording";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class FakeMediaRecorder {
  static readonly instances: FakeMediaRecorder[] = [];
  static supportedTypes = new Set(["video/webm;codecs=vp9"]);
  static outputMimeType: string | undefined;
  static stopError: unknown;
  deferStop = false;
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
    if (this.deferStop) return;
    this.finishStop();
  }

  emitChunk(data: Blob): void {
    for (const listener of this.listeners.get("dataavailable") ?? []) {
      const event = Object.assign(new Event("dataavailable"), { data });
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }

  finishStop(): void {
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
    requestDisplayMediaCapture.mockImplementation((tabId: string) => {
      const trigger = Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER);
      if (typeof trigger !== "function" || trigger(tabId) !== true) {
        throw new Error(`No pending display-media capture for ${tabId}.`);
      }
    });
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
    useBrowserSurfaceStore.setState({
      activityByTabId: {},
      backgroundCaptureCountByTabId: {},
      byTabId: {},
    });
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

  it("waits for the original encoder flush after a stop deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await startBrowserRecording("flush-retry");
    const recorder = FakeMediaRecorder.instances[0]!;
    recorder.deferStop = true;
    recorder.emitChunk(new Blob(["first"]));
    const first = expect(stopBrowserRecording("flush-retry", 40)).rejects.toMatchObject({
      operation: "stop-deadline",
    });
    await vi.advanceTimersByTimeAsync(40);
    await first;
    const retry = stopBrowserRecording("flush-retry", 100);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).not.toHaveBeenCalled();
    recorder.emitChunk(new Blob(["last"]));
    recorder.finishStop();
    await retry;
    expect(new TextDecoder().decode(save.mock.calls[0]![2])).toBe("firstlast");
  });

  it("releases startup state when settings hydration exceeds its deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const hydration = deferred<void>();
    vi.mocked(ensureClientSettingsHydrated).mockReturnValueOnce(hydration.promise);
    const started = expect(
      startBrowserRecording("hydration-timeout", null, "hydration-timeout", 40),
    ).rejects.toBeInstanceOf(BrowserRecordingCaptureTimeoutError);
    await vi.advanceTimersByTimeAsync(40);
    await started;
    expect(readActiveBrowserRecordingTabIds().has("hydration-timeout")).toBe(false);
    expect(useBrowserSurfaceStore.getState().activityByTabId["hydration-timeout"]).toBeUndefined();
    hydration.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(startScreencast).not.toHaveBeenCalled();
  });

  it("bounds paint readiness by a short startup deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    const started = expect(
      startBrowserRecording("paint-timeout", null, "paint-timeout", 40),
    ).rejects.toBeInstanceOf(BrowserRecordingCaptureTimeoutError);
    await vi.advanceTimersByTimeAsync(40);
    await started;
    expect(readActiveBrowserRecordingTabIds().has("paint-timeout")).toBe(false);
    expect(startScreencast).not.toHaveBeenCalled();
  });

  it("cancels a queued grant when its startup deadline expires", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const blocked = deferred<void>();
    startScreencast.mockImplementationOnce(() => blocked.promise);
    const first = startBrowserRecording("grant-owner");
    await vi.advanceTimersByTimeAsync(0);
    const queued = expect(
      startBrowserRecording("grant-timeout", null, "grant-timeout", 40),
    ).rejects.toBeInstanceOf(BrowserRecordingCaptureTimeoutError);
    await vi.advanceTimersByTimeAsync(40);
    await queued;
    expect(readActiveBrowserRecordingTabIds().has("grant-timeout")).toBe(false);
    blocked.resolve();
    await first;
    await stopBrowserRecording("grant-owner");
    expect(startScreencast.mock.calls.map(([tabId]) => tabId)).toEqual(["grant-owner"]);
  });

  it("routes gesture-free starts through the desktop capture trigger", async () => {
    await startBrowserRecording("automation-recording-tab");

    expect(requestDisplayMediaCapture).toHaveBeenCalledWith("automation-recording-tab");
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    await stopBrowserRecording("automation-recording-tab");
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

  it("retries a failed transfer without saving again or retaining native capture", async () => {
    await startBrowserRecording("failed-transfer-tab");
    const transfer = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce("uploaded-recording");
    await expect(stopBrowserRecordingForUpload("failed-transfer-tab", transfer)).rejects.toThrow(
      "Connection interrupted",
    );
    expect(readActiveBrowserRecordingTabIds().has("failed-transfer-tab")).toBe(true);
    expect(
      useBrowserSurfaceStore.getState().activityByTabId["failed-transfer-tab"],
    ).toBeUndefined();
    await expect(
      stopBrowserRecordingForUpload("failed-transfer-tab", transfer),
    ).resolves.toMatchObject({
      uploadedAttachmentId: "uploaded-recording",
    });
    expect(save).toHaveBeenCalledOnce();
    expect(stopScreencast).toHaveBeenCalledOnce();
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(readActiveBrowserRecordingTabIds().has("failed-transfer-tab")).toBe(false);
  });

  it("bounds a pending upload and lets a retry join it without uploading twice", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await startBrowserRecording("pending-transfer-tab");
    const upload = deferred<string>();
    const started = deferred<void>();
    const transfer = vi.fn(() => {
      started.resolve();
      return upload.promise;
    });
    const firstStop = stopBrowserRecordingForUpload("pending-transfer-tab", transfer, 40);
    const rejected = expect(firstStop).rejects.toMatchObject({ operation: "stop-deadline" });
    await started.promise;
    await vi.advanceTimersByTimeAsync(40);
    await rejected;
    expect(readActiveBrowserRecordingTabIds().has("pending-transfer-tab")).toBe(true);
    const retry = stopBrowserRecordingForUpload("pending-transfer-tab", transfer, 100);
    upload.resolve("uploaded-once");
    await expect(retry).resolves.toMatchObject({ uploadedAttachmentId: "uploaded-once" });
    expect(transfer).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds().has("pending-transfer-tab")).toBe(false);
  });

  it("shares a fresh transfer when concurrent retries join an expired upload", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await startBrowserRecording("expired-transfer-tab");
    const mint = deferred<void>();
    const started = deferred<void>();
    const firstDeadline = Date.now() + 40;
    const firstTransfer = vi.fn(async () => {
      started.resolve();
      await mint.promise;
      if (Date.now() >= firstDeadline) {
        throw new PreviewAutomationRecordingDeadlineExpiredError({
          threadId: ThreadId.make("thread"),
        });
      }
      return "first-upload";
    });
    const firstStop = stopBrowserRecordingForUpload("expired-transfer-tab", firstTransfer, 40);
    const rejected = expect(firstStop).rejects.toMatchObject({ operation: "stop-deadline" });
    await started.promise;
    await vi.advanceTimersByTimeAsync(40);
    await rejected;
    const transfer = vi.fn(async () => "fresh-upload");
    const retries = [
      stopBrowserRecordingForUpload("expired-transfer-tab", transfer, 100),
      stopBrowserRecordingForUpload("expired-transfer-tab", transfer, 100),
    ];
    // Let both stop calls join the old transfer before its delayed mint completes.
    await vi.advanceTimersByTimeAsync(0);
    mint.resolve();
    await expect(Promise.all(retries)).resolves.toEqual([
      expect.objectContaining({ uploadedAttachmentId: "fresh-upload" }),
      expect.objectContaining({ uploadedAttachmentId: "fresh-upload" }),
    ]);
    expect(firstTransfer).toHaveBeenCalledOnce();
    expect(transfer).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds().has("expired-transfer-tab")).toBe(false);
  });

  it("keeps a late upload success for the next stop request", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await startBrowserRecording("late-transfer-tab");
    const upload = deferred<string>();
    const started = deferred<void>();
    const transfer = vi.fn(() => {
      started.resolve();
      return upload.promise;
    });
    const firstStop = stopBrowserRecordingForUpload("late-transfer-tab", transfer, 40);
    const rejected = expect(firstStop).rejects.toMatchObject({ operation: "stop-deadline" });
    await started.promise;
    await vi.advanceTimersByTimeAsync(40);
    await rejected;
    upload.resolve("late-upload");
    await upload.promise;
    expect(readActiveBrowserRecordingTabIds().has("late-transfer-tab")).toBe(true);
    await expect(
      stopBrowserRecordingForUpload("late-transfer-tab", transfer, 100),
    ).resolves.toMatchObject({
      uploadedAttachmentId: "late-upload",
    });
    expect(transfer).toHaveBeenCalledOnce();
  });

  it("allows a local stop to release a failed transfer before starting another recording", async () => {
    await startBrowserRecording("local-transfer-tab");
    await expect(
      stopBrowserRecordingForUpload("local-transfer-tab", async () => {
        throw new Error("Offline");
      }),
    ).rejects.toThrow("Offline");
    await expect(stopBrowserRecording("local-transfer-tab")).resolves.toMatchObject({
      path: "/tmp/recording-test.webm",
    });
    expect(save).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds().has("local-transfer-tab")).toBe(false);
    await startBrowserRecording("local-transfer-tab");
    await stopBrowserRecording("local-transfer-tab");
  });

  it("paints and holds a hidden browser surface for the recording lifetime", async () => {
    startScreencast.mockImplementationOnce(async (tabId: string) => {
      expect(animationFrameCount).toBe(2);
      expect(useBrowserSurfaceStore.getState().activityByTabId[tabId]).toBe(1);
    });
    getDisplayMedia.mockImplementationOnce(async () => {
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
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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
    getDisplayMedia.mockResolvedValueOnce(stream);

    await startBrowserRecording("recording-tab");

    expect(getDisplayMedia).toHaveBeenCalledWith({
      audio: false,
      video: { frameRate: { ideal: 30, max: 30 } },
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

    expect(getDisplayMedia).toHaveBeenCalledWith({
      audio: false,
      video: { frameRate: { ideal: 60, max: 60 } },
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
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);

    clientSettings.browserRecordingFrameRate = 60;
    await startBrowserRecording(tabId);

    expect(getDisplayMedia).toHaveBeenCalledWith({
      audio: false,
      video: { frameRate: { ideal: 60, max: 60 } },
    });
    await stopBrowserRecording(tabId);

    expect(startScreencast).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
    expect(useBrowserSurfaceStore.getState().activityByTabId[tabId]).toBeUndefined();
  });

  it("stops the native stream when MediaRecorder cleanup fails", async () => {
    const stopTrack = vi.fn();
    getDisplayMedia.mockResolvedValueOnce({
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
      expect.any(String),
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
      expect.any(String),
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
    getDisplayMedia.mockRejectedValueOnce(new Error("capture failed"));

    await expect(startBrowserRecording("recording-tab")).rejects.toMatchObject({
      operation: "capture-media-stream",
      tabId: "recording-tab",
    });

    expect(stopScreencast).toHaveBeenCalledWith("recording-tab");
    expect(events.at(-1)).toBe("clear");
  });

  it("times out stalled stream acquisition and stops a late stream", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let finishCapture!: (stream: MediaStream) => void;
    const stopTrack = vi.fn();
    getDisplayMedia.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          finishCapture = resolve;
        }),
    );

    const startPromise = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(getDisplayMedia).toHaveBeenCalledOnce());
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

  it("clamps stream acquisition and cleanup to the caller's startup deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let observeCaptureStarted: (() => void) | undefined;
    const captureStarted = new Promise<void>((resolve) => {
      observeCaptureStarted = resolve;
    });
    getDisplayMedia.mockImplementationOnce(() => {
      observeCaptureStarted?.();
      return new Promise<MediaStream>(() => undefined);
    });

    const startPromise = startBrowserRecording("recording-tab", null, "recording-tab", 40);
    await captureStarted;
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    const rejection = expect(startPromise).rejects.toMatchObject({
      _tag: "BrowserRecordingCaptureTimeoutError",
      tabId: "recording-tab",
      timeoutMs: 40,
    });
    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(0);

    await rejection;
    expect(startScreencast).toHaveBeenCalledWith("recording-tab", 40);
    expect(stopScreencast).toHaveBeenCalledWith("recording-tab", 1);
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it.each(["stalled", "failed"])(
    "preserves diagnostics when startup cleanup is %s",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const grant = deferred<void>();
      const cleanup = deferred<undefined>();
      const nativeFailure = new Error("native stop failed");
      startScreencast.mockImplementationOnce(() => grant.promise);
      stopScreencast.mockImplementationOnce(() =>
        mode === "stalled" ? cleanup.promise : Promise.reject(nativeFailure),
      );
      const result = startBrowserRecording("cleanup-deadline", null, "cleanup-deadline", 40).catch(
        (cause: unknown) => cause,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(startScreencast).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(41);
      const cause = await result;
      if (mode === "stalled") {
        expect(cause).toBeInstanceOf(BrowserRecordingCaptureTimeoutError);
      } else {
        expect(cause).toMatchObject({
          _tag: "BrowserRecordingOperationError",
          operation: "cleanup",
          cause: expect.objectContaining({
            cause: expect.any(BrowserRecordingCaptureTimeoutError),
            errors: [expect.any(BrowserRecordingCaptureTimeoutError), nativeFailure],
          }),
        });
      }
      expect(readActiveBrowserRecordingTabIds().has("cleanup-deadline")).toBe(false);
      cleanup.resolve(undefined);
      grant.resolve();
      await vi.advanceTimersByTimeAsync(0);
    },
  );

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

  it("serializes display media grants for concurrent recording starts", async () => {
    let finishFirstCapture!: (stream: MediaStream) => void;
    const stream = {
      getVideoTracks: () => [],
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    getDisplayMedia
      .mockImplementationOnce(
        () =>
          new Promise<MediaStream>((resolve) => {
            finishFirstCapture = resolve;
          }),
      )
      .mockResolvedValueOnce(stream);

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(getDisplayMedia).toHaveBeenCalledOnce());
    const secondStart = startBrowserRecording("recording-tab-2");
    await vi.waitFor(() => expect(readActiveBrowserRecordingTabIds().size).toBe(2));

    expect(startScreencast).toHaveBeenCalledTimes(1);
    finishFirstCapture(stream);
    await Promise.all([firstStart, secondStart]);

    expect(startScreencast.mock.calls).toEqual([["recording-tab"], ["recording-tab-2"]]);
    expect(getDisplayMedia).toHaveBeenCalledTimes(2);
    await Promise.all([
      stopBrowserRecording("recording-tab"),
      stopBrowserRecording("recording-tab-2"),
    ]);
  });

  it("cancels a queued recording when stopped before its media grant", async () => {
    let finishFirstCapture!: (stream: MediaStream) => void;
    const stream = {
      getVideoTracks: () => [],
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    getDisplayMedia.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          finishFirstCapture = resolve;
        }),
    );

    const firstStart = startBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(getDisplayMedia).toHaveBeenCalledOnce());
    const secondStart = startBrowserRecording("recording-tab-2");
    await vi.waitFor(() => expect(readActiveBrowserRecordingTabIds().size).toBe(2));

    const secondStop = stopBrowserRecording("recording-tab-2");
    await expect(secondStart).rejects.toBeInstanceOf(BrowserRecordingStartCancelledError);
    await expect(secondStop).resolves.toBeNull();
    expect(startScreencast).toHaveBeenCalledTimes(1);

    finishFirstCapture(stream);
    await firstStart;
    await stopBrowserRecording("recording-tab");
    expect(getDisplayMedia).toHaveBeenCalledOnce();
  });

  it("latches a stop that arrives before the start becomes queued", async () => {
    let releaseDelayedPaint!: (timestamp: number) => void;
    let frameId = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameId += 1;
        if (frameId === 1) releaseDelayedPaint = callback;
        else callback(frameId);
        return frameId;
      }),
    );
    let finishBlockingCapture!: (stream: MediaStream) => void;
    const stream = {
      getVideoTracks: () => [],
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    getDisplayMedia.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          finishBlockingCapture = resolve;
        }),
    );

    const delayedStart = startBrowserRecording("delayed-tab");
    await vi.waitFor(() =>
      expect(readActiveBrowserRecordingTabIds().has("delayed-tab")).toBe(true),
    );
    const blockingStart = startBrowserRecording("blocking-tab");
    await vi.waitFor(() => expect(getDisplayMedia).toHaveBeenCalledOnce());

    const delayedStop = stopBrowserRecording("delayed-tab");
    releaseDelayedPaint(1);

    await expect(delayedStart).rejects.toBeInstanceOf(BrowserRecordingStartCancelledError);
    await expect(delayedStop).resolves.toBeNull();
    expect(startScreencast).toHaveBeenCalledOnce();

    finishBlockingCapture(stream);
    await blockingStart;
    await stopBrowserRecording("blocking-tab");
  });

  it("finishes an uncontended pre-grant start before stopping", async () => {
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

  it("retains captured chunks when a bounded stop expires so finalization can be retried", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let finishStoppingScreencast: (() => void) | undefined;
    let observeStopStarted: (() => void) | undefined;
    const stopStarted = new Promise<void>((resolve) => {
      observeStopStarted = resolve;
    });
    stopScreencast.mockImplementationOnce(async () => {
      observeStopStarted?.();
      await new Promise<void>((resolve) => {
        finishStoppingScreencast = resolve;
      });
    });
    await startBrowserRecording("recording-tab");

    const stopPromise = stopBrowserRecording("recording-tab", 40);
    const rejection = expect(stopPromise).rejects.toMatchObject({
      operation: "stop-deadline",
      tabId: "recording-tab",
    });
    await stopStarted;
    expect(stopScreencast).toHaveBeenCalledWith("recording-tab", 40);
    await vi.advanceTimersByTimeAsync(40);

    await rejection;
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set(["recording-tab"]));

    finishStoppingScreencast?.();
    await vi.advanceTimersByTimeAsync(0);
    await expect(stopBrowserRecording("recording-tab")).resolves.toMatchObject({
      tabId: "recording-tab",
    });
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it("shares an in-flight artifact save with a retry after the renderer deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let finishSaving: ((artifact: Awaited<ReturnType<typeof save>>) => void) | undefined;
    let observeSaveStarted: (() => void) | undefined;
    const saveStarted = new Promise<void>((resolve) => {
      observeSaveStarted = resolve;
    });
    save.mockImplementationOnce(async () => {
      observeSaveStarted?.();
      return await new Promise<Awaited<ReturnType<typeof save>>>((resolve) => {
        finishSaving = resolve;
      });
    });
    await startBrowserRecording("recording-tab");

    const firstStop = stopBrowserRecording("recording-tab", 40);
    const rejection = expect(firstStop).rejects.toMatchObject({ operation: "stop-deadline" });
    await saveStarted;
    await vi.advanceTimersByTimeAsync(40);
    await rejection;

    const retry = stopBrowserRecording("recording-tab");
    expect(save).toHaveBeenCalledOnce();
    finishSaving?.({
      id: "recording-test",
      tabId: "recording-tab",
      path: "/tmp/recording-test.webm",
      mimeType: "video/webm",
      sizeBytes: 0,
      createdAt: "2026-06-26T00:00:00.000Z",
    });

    await expect(retry).resolves.toMatchObject({ id: "recording-test" });
    expect(save).toHaveBeenCalledOnce();
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it("keeps recording state retryable when the desktop stop deadline rejects first", async () => {
    stopScreencast.mockRejectedValueOnce({
      _tag: "PreviewAutomationTimeoutError",
      tabId: "recording-tab",
      timeoutMs: 40,
    });
    await startBrowserRecording("recording-tab");

    await expect(stopBrowserRecording("recording-tab", 40)).rejects.toMatchObject({
      operation: "stop-deadline",
      tabId: "recording-tab",
    });
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set(["recording-tab"]));

    await expect(stopBrowserRecording("recording-tab")).resolves.toMatchObject({
      tabId: "recording-tab",
    });
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
  });

  it("reuses the artifact idempotency key after a desktop save timeout", async () => {
    save.mockRejectedValueOnce({
      _tag: "PreviewAutomationTimeoutError",
      tabId: "recording-tab",
      timeoutMs: 40,
    });
    await startBrowserRecording("recording-tab");

    await expect(stopBrowserRecording("recording-tab", 40)).rejects.toMatchObject({
      operation: "stop-deadline",
      tabId: "recording-tab",
    });
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set(["recording-tab"]));

    await expect(stopBrowserRecording("recording-tab")).resolves.toMatchObject({
      tabId: "recording-tab",
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]?.[3]).toEqual(expect.any(String));
    expect(save.mock.calls[1]?.[3]).toBe(save.mock.calls[0]?.[3]);
    expect(readActiveBrowserRecordingTabIds()).toEqual(new Set());
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
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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
