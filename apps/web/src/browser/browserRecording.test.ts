import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  events,
  frameSubscription,
  onFrame,
  registrySet,
  save,
  startScreencast,
  stopScreencast,
  surfaceState,
} = vi.hoisted(() => {
  const events: string[] = [];
  type Frame = {
    readonly tabId: string;
    readonly data: string;
    readonly width: number;
    readonly height: number;
    readonly receivedAt: string;
  };
  const frameSubscription: { listener: ((frame: Frame) => void) | null } = {
    listener: null,
  };
  const surfaceState = {
    byTabId: {} as Record<string, unknown>,
  };
  return {
    events,
    frameSubscription,
    onFrame: vi.fn((listener: (frame: Frame) => void) => {
      frameSubscription.listener = listener;
      return () => {
        if (frameSubscription.listener === listener) frameSubscription.listener = null;
      };
    }),
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
    startScreencast: vi.fn(async (tabId: string) => {
      events.push("start-screencast");
      const surface = surfaceState.byTabId[tabId] as
        | {
            readonly content?: { readonly width: number; readonly height: number };
            readonly rect?: { readonly width: number; readonly height: number };
          }
        | undefined;
      const size = surface?.content ?? surface?.rect;
      frameSubscription.listener?.({
        tabId,
        data: "initial-frame",
        width: size?.width ?? 1280,
        height: size?.height ?? 800,
        receivedAt: "2026-06-26T00:00:00.000Z",
      });
    }),
    stopScreencast: vi.fn(async () => undefined),
    surfaceState,
  };
});

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    recording: { onFrame, save, startScreencast, stopScreencast },
  },
}));

vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { set: registrySet },
}));

vi.mock("./browserSurfaceStore", () => ({
  useBrowserSurfaceStore: {
    getState: () => surfaceState,
  },
}));

import {
  BROWSER_RECORDING_FIRST_FRAME_SIZE_TIMEOUT_MS,
  BROWSER_RECORDING_STARTUP_SETTLE_TIMEOUT_MS,
  BrowserRecordingConflictError,
  BrowserRecordingOperationError,
  readActiveBrowserRecordingTabIds,
  startBrowserRecording,
  stopBrowserRecording,
} from "./browserRecording";

class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }

  state: RecordingState = "inactive";
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    for (const listener of this.listeners.get("stop") ?? []) {
      if (typeof listener === "function") listener(new Event("stop"));
      else listener.handleEvent(new Event("stop"));
    }
  }
}

describe("browser recording", () => {
  beforeEach(() => {
    events.length = 0;
    frameSubscription.listener = null;
    surfaceState.byTabId = {
      "recording-tab": {
        visible: true,
        rect: { x: 0, y: 0, width: 800, height: 600 },
        content: { x: 0, y: 0, width: 800, height: 600, scale: 1, scrollLeft: 0, scrollTop: 0 },
      },
    };
    vi.clearAllMocks();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder as unknown as typeof MediaRecorder);
    class ImmediateImage {
      private loadListener: EventListenerOrEventListenerObject | undefined;

      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (type === "load") this.loadListener = listener;
      }

      set src(_value: string) {
        const event = new Event("load");
        if (typeof this.loadListener === "function") this.loadListener(event);
        else this.loadListener?.handleEvent(event);
      }
    }
    vi.stubGlobal("Image", ImmediateImage as unknown as typeof Image);
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        captureStream: () => ({}),
        getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: "" }),
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts recording for a visible tab", async () => {
    await startBrowserRecording("recording-tab");

    expect(events).toEqual(["start-screencast", "publish:recording-tab"]);

    await stopBrowserRecording("recording-tab");
  });

  it("records a hidden tab without requiring it to become visible", async () => {
    surfaceState.byTabId = {
      "recording-tab": {
        visible: false,
        rect: { x: 0, y: 0, width: 800, height: 600 },
        content: { x: 0, y: 0, width: 800, height: 600, scale: 1, scrollLeft: 0, scrollTop: 0 },
      },
    };

    await startBrowserRecording("recording-tab");

    expect(startScreencast).toHaveBeenCalledWith("recording-tab");
    expect(events).toEqual(["start-screencast", "publish:recording-tab"]);

    await stopBrowserRecording("recording-tab");
  });

  it("fails startup instead of locking a fallback size when no frame arrives", async () => {
    vi.useFakeTimers();
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
    });

    const startPromise = startBrowserRecording("recording-tab");
    const rejection = expect(startPromise).rejects.toMatchObject({
      operation: "wait-first-frame",
      tabId: "recording-tab",
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(BROWSER_RECORDING_FIRST_FRAME_SIZE_TIMEOUT_MS);

    await rejection;
    expect(stopScreencast).toHaveBeenCalledWith("recording-tab");
    expect(events.at(-1)).toBe("clear");
  });

  it("fixes hidden recording dimensions before MediaRecorder starts", async () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    let capturedStreamSize: { readonly width: number; readonly height: number } | undefined;
    const canvas = {
      width: 0,
      height: 0,
      captureStream: () => {
        capturedStreamSize = { width: canvas.width, height: canvas.height };
        return {};
      },
      getContext: () => ({ drawImage, fillRect, fillStyle: "" }),
    };
    vi.stubGlobal("document", {
      createElement: () => canvas,
    });
    surfaceState.byTabId = {};
    startScreencast.mockImplementationOnce(async (tabId: string) => {
      events.push("start-screencast");
      frameSubscription.listener?.({
        tabId,
        data: "captured-frame",
        width: 390,
        height: 844,
        receivedAt: "2026-06-26T00:00:00.000Z",
      });
    });

    await startBrowserRecording("recording-tab");

    expect(canvas).toMatchObject({ width: 390, height: 844 });
    expect(capturedStreamSize).toEqual({ width: 390, height: 844 });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 390, 844);

    frameSubscription.listener?.({
      tabId: "recording-tab",
      data: "different-sized-frame",
      width: 1280,
      height: 720,
      receivedAt: "2026-06-26T00:00:01.000Z",
    });

    expect(canvas).toMatchObject({ width: 390, height: 844 });
    expect(fillRect).toHaveBeenLastCalledWith(0, 0, 390, 844);

    await stopBrowserRecording("recording-tab");
  });

  it("draws the newest decoded frames without starving behind decode latency", async () => {
    const drawImage = vi.fn();
    class DeferredImage {
      static readonly instances: DeferredImage[] = [];
      private loadListener: EventListenerOrEventListenerObject | undefined;

      constructor() {
        DeferredImage.instances.push(this);
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (type === "load") this.loadListener = listener;
      }

      set src(_value: string) {}

      finishLoading(): void {
        const event = new Event("load");
        if (typeof this.loadListener === "function") this.loadListener(event);
        else this.loadListener?.handleEvent(event);
      }
    }
    vi.stubGlobal("Image", DeferredImage as unknown as typeof Image);
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        captureStream: () => ({}),
        getContext: () => ({ drawImage, fillRect: vi.fn(), fillStyle: "" }),
      }),
    });

    await startBrowserRecording("recording-tab");
    frameSubscription.listener?.({
      tabId: "recording-tab",
      data: "second-frame",
      width: 800,
      height: 600,
      receivedAt: "2026-06-26T00:00:01.000Z",
    });
    frameSubscription.listener?.({
      tabId: "recording-tab",
      data: "third-frame",
      width: 800,
      height: 600,
      receivedAt: "2026-06-26T00:00:02.000Z",
    });

    DeferredImage.instances[1]?.finishLoading();
    expect(drawImage).toHaveBeenCalledOnce();
    DeferredImage.instances[2]?.finishLoading();
    expect(drawImage).toHaveBeenCalledTimes(2);
    DeferredImage.instances[0]?.finishLoading();
    expect(drawImage).toHaveBeenCalledTimes(2);

    await stopBrowserRecording("recording-tab");
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
    surfaceState.byTabId = {
      ...surfaceState.byTabId,
      "recording-tab-2": {
        visible: false,
        rect: { x: 0, y: 0, width: 390, height: 844 },
        content: { x: 0, y: 0, width: 390, height: 844, scale: 1, scrollLeft: 0, scrollTop: 0 },
      },
    };

    await Promise.all([
      startBrowserRecording("recording-tab", firstThreadRef),
      startBrowserRecording("recording-tab-2", secondThreadRef),
    ]);

    expect(startScreencast).toHaveBeenCalledTimes(2);
    expect(onFrame).toHaveBeenCalledOnce();
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

  it("does not report success for a second start while the first is still starting", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async (tabId: string) => {
      events.push("start-screencast");
      frameSubscription.listener?.({
        tabId,
        data: "initial-frame",
        width: 800,
        height: 600,
        receivedAt: "2026-06-26T00:00:00.000Z",
      });
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

  it("stops a screencast that finishes starting after cancellation", async () => {
    let finishStartingScreencast: (() => void) | undefined;
    startScreencast.mockImplementationOnce(async () => {
      events.push("start-screencast");
      await new Promise<void>((resolve) => {
        finishStartingScreencast = resolve;
      });
    });

    const startPromise = startBrowserRecording("recording-tab");
    const rejectedStart = expect(startPromise).rejects.toBeInstanceOf(
      BrowserRecordingOperationError,
    );
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce());
    finishStartingScreencast?.();

    await rejectedStart;
    await stopPromise;
    expect(stopScreencast).toHaveBeenCalledTimes(2);
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
    const rejectedFirstStart = expect(firstStart).rejects.toBeInstanceOf(
      BrowserRecordingOperationError,
    );
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    const restartAfterStop = stopPromise.then(() => startBrowserRecording("recording-tab"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startCallsBeforeFirstSettled = startScreencast.mock.calls.length;

    finishStartingScreencast?.();
    await rejectedFirstStart;
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
    const rejectedStart = expect(firstStart).rejects.toBeInstanceOf(BrowserRecordingOperationError);
    await vi.waitFor(() => expect(startScreencast).toHaveBeenCalledOnce());

    const stopPromise = stopBrowserRecording("recording-tab");
    const rejectedStop = expect(stopPromise).rejects.toMatchObject({
      operation: "stop-screencast",
      tabId: "recording-tab",
    });
    await vi.waitFor(() => expect(stopScreencast).toHaveBeenCalledOnce());
    await expect(startBrowserRecording("recording-tab")).rejects.toBeInstanceOf(
      BrowserRecordingConflictError,
    );

    finishStartingScreencast?.();
    await rejectedStart;
    await rejectedStop;

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
    const rejectedStart = expect(startPromise).rejects.toBeInstanceOf(
      BrowserRecordingOperationError,
    );
    expect(startScreencast).toHaveBeenCalledOnce();

    const stopPromise = stopBrowserRecording("recording-tab");
    await Promise.resolve();
    await Promise.resolve();
    expect(stopScreencast).toHaveBeenCalledOnce();

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
    await rejectedStart;
    const cleanupResult = await stopBrowserRecording("recording-tab");
    expect(cleanupResult).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe("clear");
  });
});
