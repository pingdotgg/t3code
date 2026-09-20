import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  mountBrowser: vi.fn<DesktopPreviewBridge["browser"]["mount"]>(),
  layoutBrowser: vi.fn<DesktopPreviewBridge["browser"]["layout"]>(),
  browserInput: vi.fn<DesktopPreviewBridge["browser"]["input"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  activeRecordings: new Set<string>(),
  captureBrowserViewStream: vi.fn<() => Promise<MediaStream>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: mocks }),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    browser: {
      mount: mocks.mountBrowser,
      layout: mocks.layoutBrowser,
      input: mocks.browserInput,
      onCursorChange: () => () => undefined,
    },
    getPreviewConfig: mocks.getPreviewConfig,
  },
}));

vi.mock("~/components/preview/usePreviewBridge", () => ({
  usePreviewBridge: () => undefined,
}));

vi.mock("./browserRecording", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browserRecording")>()),
  captureBrowserViewStream: mocks.captureBrowserViewStream,
  useActiveBrowserRecordingTabIds: () => mocks.activeRecordings,
  stopBrowserRecording: async () => null,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { acquireBrowserSurface, useBrowserSurfaceStore } from "./browserSurfaceStore";
import * as desktopTabLifetime from "./desktopTabLifetime";
import { HostedBrowserView } from "./HostedBrowserView";
import { BrowserRecordingUnavailableError } from "./browserRecording";

let renderer: ReactTestRenderer | undefined;

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  mocks.getClientSettings.mockReset();
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.mountBrowser.mockReset().mockResolvedValue(undefined);
  mocks.layoutBrowser.mockReset().mockResolvedValue(undefined);
  mocks.browserInput.mockReset().mockResolvedValue(undefined);
  mocks.captureBrowserViewStream.mockReset();
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-work",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("reportError", vi.fn());
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 0),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useFakeTimers();
  await act(() => renderer?.unmount());
  renderer = undefined;
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HostedBrowserView settings hydration", () => {
  it("starts a retained background tab only after a settings read succeeds on retry", async () => {
    const firstRead = deferred<ClientSettings | null>();
    const retryRead = deferred<ClientSettings | null>();
    const tabCreation = deferred<void>();
    mocks.getClientSettings
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(retryRead.promise);
    mocks.createTab.mockReturnValueOnce(tabCreation.promise);
    const acquire = vi.spyOn(desktopTabLifetime, "acquireDesktopTab");
    const threadRef = {
      environmentId: EnvironmentId.make("host-settings-retry"),
      threadId: ThreadId.make("thread-settings-retry"),
    };
    const runtimeTabId = "retained-background-tab";
    useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);

    await act(() => {
      renderer = create(
        <HostedBrowserView
          threadRef={threadRef}
          tabId="server-tab"
          runtimeTabId={runtimeTabId}
          initialUrl="https://example.com"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          profileId="work"
          zoomFactor={1.25}
        />,
        {
          createNodeMock: () => ({ scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined }),
        },
      );
    });

    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(mocks.mountBrowser).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    const failure = new Error("Saved settings are unavailable");
    await act(async () => {
      const hydration = ensureClientSettingsHydrated();
      firstRead.reject(failure);
      await expect(hydration).rejects.toBe(failure);
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(mocks.mountBrowser).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    let retry!: Promise<void>;
    await act(() => {
      retry = ensureClientSettingsHydrated();
    });
    expect(mocks.getClientSettings).toHaveBeenCalledTimes(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(mocks.mountBrowser).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    await act(async () => {
      retryRead.resolve({
        ...DEFAULT_CLIENT_SETTINGS,
        browserDefaultZoomFactor: 1.25,
        browserDefaultAppearance: "dark",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
        browserDefaultProfileId: "work",
      });
      await retry;
    });

    expect(acquire).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId, {
      zoomFactor: 1.25,
      colorScheme: "dark",
    });
    expect(mocks.mountBrowser).not.toHaveBeenCalled();

    await act(async () => {
      tabCreation.resolve();
      await tabCreation.promise;
    });
    expect(mocks.mountBrowser).toHaveBeenCalledExactlyOnceWith(
      runtimeTabId,
      threadRef.environmentId,
      "work",
      "https://example.com",
    );
    expect(mocks.closeTab).not.toHaveBeenCalled();
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });
});

describe("HostedBrowserView capture and input", () => {
  const mount = async () => {
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await ensureClientSettingsHydrated();
    const lease = acquireBrowserSurface("capture-tab");
    const rect = { x: 0, y: 0, width: 400, height: 300, right: 400, bottom: 300 };
    lease.present(rect, true);
    const capturedPointers = new Set<number>();
    const node = Object.assign(new EventTarget(), {
      srcObject: null as MediaStream | null,
      getBoundingClientRect: () => rect,
      scrollTo: () => undefined,
      focus: () => undefined,
      setPointerCapture: (id: number) => capturedPointers.add(id),
      hasPointerCapture: (id: number) => capturedPointers.has(id),
      releasePointerCapture: (id: number) => capturedPointers.delete(id),
      scrollLeft: 0,
      scrollTop: 0,
      style: {},
    });
    await act(() => {
      renderer = create(
        <HostedBrowserView
          threadRef={{
            environmentId: EnvironmentId.make("capture-env"),
            threadId: ThreadId.make("capture-thread"),
          }}
          tabId="capture-server-tab"
          runtimeTabId="capture-tab"
          initialUrl="about:blank"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          profileId={undefined}
          zoomFactor={1}
        />,
        { createNodeMock: () => node },
      );
    });
    return { lease, node };
  };
  const media = () => {
    const track = Object.assign(new EventTarget(), { stop: vi.fn() });
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    return { track, stream };
  };

  it.each([
    [1, "middle"],
    [2, "right"],
  ] as const)("releases button %s when its pointer is canceled", async (button, nativeButton) => {
    mocks.captureBrowserViewStream.mockResolvedValue(media().stream);
    const { node } = await mount();
    const video = renderer!.root.findByType("video");
    const event = {
      currentTarget: node,
      preventDefault: vi.fn(),
      pointerId: 7,
      clientX: 20,
      clientY: 30,
      detail: 1,
      buttons: 0,
    };
    await act(() => video.props.onPointerDown({ ...event, type: "pointerdown", button }));
    await act(() => video.props.onPointerCancel({ ...event, type: "pointercancel", button: -1 }));
    expect(mocks.browserInput.mock.calls.map(([, input]) => input)).toEqual([
      expect.objectContaining({ type: "mouseDown", button: nativeButton }),
      expect.objectContaining({ type: "mouseUp", button: nativeButton }),
    ]);
    // The canceled pointer no longer owns a button.
    await act(() => video.props.onPointerCancel({ ...event, type: "pointercancel", button: -1 }));
    expect(mocks.browserInput).toHaveBeenCalledTimes(2);
  });

  it("recovers a transient startup failure and a subsequently ended track", async () => {
    vi.useFakeTimers();
    const first = media();
    const second = media();
    mocks.captureBrowserViewStream
      .mockRejectedValueOnce(new Error("capture timeout"))
      .mockResolvedValueOnce(first.stream)
      .mockResolvedValueOnce(second.stream);
    const { node, lease } = await mount();
    expect(node.srcObject).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(node.srcObject).toBe(first.stream);
    await act(() => first.track.dispatchEvent(new Event("ended")));
    expect(first.track.stop).toHaveBeenCalledOnce();
    expect(node.srcObject).toBe(second.stream);
    await act(() => lease.release());
    expect(second.track.stop).toHaveBeenCalledOnce();
    expect(node.srcObject).toBeNull();
  });

  it("bounds automatic retries and allows an explicit retry without switching tabs", async () => {
    vi.useFakeTimers();
    mocks.captureBrowserViewStream.mockRejectedValue(new Error("capture unavailable"));
    const { node } = await mount();
    await act(() => vi.advanceTimersByTimeAsync(750));
    expect(mocks.captureBrowserViewStream).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.captureBrowserViewStream).toHaveBeenCalledTimes(3);
    const recovered = media();
    mocks.captureBrowserViewStream.mockResolvedValue(recovered.stream);
    const retry = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Retry displaying page"));
    expect(retry).toBeDefined();
    await act(() => retry!.props.onClick());
    expect(node.srcObject).toBe(recovered.stream);
  });

  it("reports an unavailable desktop bridge without automatic retries", async () => {
    vi.useFakeTimers();
    const error = new BrowserRecordingUnavailableError({ tabId: "capture-tab" });
    mocks.captureBrowserViewStream.mockRejectedValue(error);
    await mount();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.captureBrowserViewStream).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(error);
  });

  it("cancels a scheduled retry when the page becomes inactive", async () => {
    vi.useFakeTimers();
    mocks.captureBrowserViewStream.mockRejectedValue(new Error("capture timeout"));
    const { lease } = await mount();
    await act(() => lease.release());
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.captureBrowserViewStream).toHaveBeenCalledOnce();
  });
});
