import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type DesktopPreviewCaptureRequest,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  activeRecordings: new Set<string>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: mocks }),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
  },
}));

vi.mock("~/components/preview/usePreviewBridge", () => ({
  usePreviewBridge: () => undefined,
}));

vi.mock("./browserRecording", () => ({
  useActiveBrowserRecordingTabIds: () => mocks.activeRecordings,
  stopBrowserRecording: async () => null,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import * as desktopTabLifetime from "./desktopTabLifetime";
import { HostedBrowserWebview } from "./HostedBrowserWebview";

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
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-work",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", globalThis);
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

describe("HostedBrowserWebview settings hydration", () => {
  it("keeps concurrent captures paintable until release without selecting their tab", async () => {
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    const listeners = new Set<(event: DesktopPreviewCaptureRequest) => void>();
    const acknowledgeCapture = vi.fn(async (_requestId: string) => undefined);
    vi.stubGlobal("desktopBridge", {
      preview: {
        onCaptureRequest: (listener: (event: DesktopPreviewCaptureRequest) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        acknowledgeCapture,
      },
    });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    const runtimeTabId = "capture-background";
    await act(async () => {
      renderer = create(
        <HostedBrowserWebview
          threadRef={{
            environmentId: EnvironmentId.make("capture-host"),
            threadId: ThreadId.make("capture-thread"),
          }}
          tabId="capture-tab"
          runtimeTabId={runtimeTabId}
          initialUrl="https://example.com"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          profileId="work"
          zoomFactor={1}
        />,
        {
          createNodeMock: (element) =>
            element.type === "webview"
              ? Object.assign(new EventTarget(), { getWebContentsId: () => 41 })
              : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
        },
      );
    });
    const send = (requestId: string, active: boolean, webContentsId = 41) =>
      act(() => {
        for (const listener of listeners) listener({ requestId, active, webContentsId });
      });
    await send("other-guest", true, 42);
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBeUndefined();
    let releaseOtherActivity: () => void = () => undefined;
    await act(() => {
      releaseOtherActivity = useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);
    });
    await send("cancelled", true);
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBe(2);
    await act(() => {
      for (const frame of frames.splice(0)) frame(1);
    });
    await send("cancelled", false);
    await act(() => {
      for (const frame of frames.splice(0)) frame(2);
    });
    expect(acknowledgeCapture).not.toHaveBeenCalled();
    // Cancelling a screenshot must preserve another consumer's activity lease.
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBe(1);
    await act(releaseOtherActivity);
    await send("first", true);
    await send("second", true);
    await send("first", true); // Duplicate IPC delivery must not leak a lease.
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBe(2);
    expect(acknowledgeCapture).not.toHaveBeenCalled();
    await act(() => {
      for (const frame of frames.splice(0)) frame(1);
    });
    await act(() => {
      for (const frame of frames.splice(0)) frame(2);
    });
    expect(acknowledgeCapture.mock.calls.map(([id]) => id)).toEqual(["first", "second"]);
    expect(useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible).not.toBe(true);
    await send("first", false);
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBe(1);
    await act(() => renderer?.unmount());
    renderer = undefined;
    expect(useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId]).toBeUndefined();
    expect(listeners.size).toBe(0);
  });

  it("starts a retained background tab only after a settings read succeeds on retry", async () => {
    const firstRead = deferred<ClientSettings | null>();
    const retryRead = deferred<ClientSettings | null>();
    const tabCreation = deferred<void>();
    mocks.getClientSettings
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(retryRead.promise);
    mocks.createTab.mockReturnValueOnce(tabCreation.promise);
    const acquire = vi.spyOn(desktopTabLifetime, "acquireDesktopTab");
    const createGuest = vi.fn((_attributes: unknown) =>
      Object.assign(new EventTarget(), { getWebContentsId: () => 41 }),
    );
    const threadRef = {
      environmentId: EnvironmentId.make("host-settings-retry"),
      threadId: ThreadId.make("thread-settings-retry"),
    };
    const runtimeTabId = "retained-background-tab";
    useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);

    await act(() => {
      renderer = create(
        <HostedBrowserWebview
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
          createNodeMock: (element) =>
            element.type === "webview"
              ? createGuest(element.props)
              : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
        },
      );
    });

    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    const failure = new Error("Saved settings are unavailable");
    await act(async () => {
      const hydration = ensureClientSettingsHydrated();
      firstRead.reject(failure);
      await expect(hydration).rejects.toBe(failure);
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    let retry!: Promise<void>;
    await act(() => {
      retry = ensureClientSettingsHydrated();
    });
    expect(mocks.getClientSettings).toHaveBeenCalledTimes(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
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

    expect(acquire).toHaveBeenCalledExactlyOnceWith(runtimeTabId, undefined);
    expect(mocks.getPreviewConfig).toHaveBeenCalledExactlyOnceWith(threadRef.environmentId, "work");
    expect(createGuest).toHaveBeenCalledOnce();
    expect(createGuest).toHaveBeenCalledWith(
      expect.objectContaining({
        partition: "persist:t3-preview-work",
        src: "https://example.com",
      }),
    );
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId, {
      zoomFactor: 1.25,
      colorScheme: "dark",
    });
    expect(mocks.registerWebview).not.toHaveBeenCalled();

    await act(async () => {
      tabCreation.resolve();
      await tabCreation.promise;
    });
    expect(mocks.registerWebview).toHaveBeenCalledExactlyOnceWith(runtimeTabId, 41);
    expect(mocks.closeTab).not.toHaveBeenCalled();
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });
});
