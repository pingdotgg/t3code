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
      onCursorChange: () => () => undefined,
    },
    getPreviewConfig: mocks.getPreviewConfig,
  },
}));

vi.mock("~/components/preview/usePreviewBridge", () => ({
  usePreviewBridge: () => undefined,
}));

vi.mock("./browserRecording", () => ({
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

describe("HostedBrowserView capture recovery", () => {
  const mount = async () => {
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await ensureClientSettingsHydrated();
    const lease = acquireBrowserSurface("capture-tab");
    const rect = { x: 0, y: 0, width: 400, height: 300, right: 400, bottom: 300 };
    lease.present(rect, true);
    const node = Object.assign(new EventTarget(), {
      srcObject: null as MediaStream | null,
      getBoundingClientRect: () => rect,
      scrollTo: () => undefined,
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

  it("cancels a scheduled retry when the page becomes inactive", async () => {
    vi.useFakeTimers();
    mocks.captureBrowserViewStream.mockRejectedValue(new Error("capture timeout"));
    const { lease } = await mount();
    await act(() => lease.release());
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.captureBrowserViewStream).toHaveBeenCalledOnce();
  });
});
