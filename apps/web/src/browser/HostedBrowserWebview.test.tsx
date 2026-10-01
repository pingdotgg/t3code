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
import { useBrowserPointerStore } from "./browserPointerStore";
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
  mocks.activeRecordings.clear();
  useBrowserPointerStore.setState({ byTabId: {} });
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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
  it("renders the native cursor over an extension surface without taking focus or duplicating recording cursors", async () => {
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await ensureClientSettingsHydrated();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const runtimeTabId = "extension-presented-tab";
    const surfaceStore = useBrowserSurfaceStore.getState();
    const owner = Symbol("extension");
    surfaceStore.claim(runtimeTabId, owner, false, false, "extension");
    surfaceStore.present(
      runtimeTabId,
      owner,
      { x: 30, y: 50, width: 900, height: 700 },
      true,
      0,
      30,
    );
    surfaceStore.presentContent(runtimeTabId, {
      x: 10,
      y: 20,
      width: 900,
      height: 700,
      scale: 0.5,
      scrollLeft: 3,
      scrollTop: 4,
    });
    useBrowserPointerStore.getState().apply({
      tabId: runtimeTabId,
      sequence: 1,
      x: 100,
      y: 80,
      phase: "move",
      createdAt: "2026-09-30T00:00:00Z",
    });
    const render = (controller: "agent" | "human") => (
      <HostedBrowserWebview
        threadRef={{ environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") }}
        tabId="server-tab"
        runtimeTabId={runtimeTabId}
        serverEpoch="epoch-1"
        initialUrl="https://example.com"
        viewport={FILL_PREVIEW_VIEWPORT}
        pictureInPicture={false}
        remoteLive={false}
        profileId="work"
        zoomFactor={1.25}
        controller={controller}
      />
    );
    await act(async () => {
      renderer = create(render("agent"), {
        createNodeMock: (element) =>
          element.type === "webview"
            ? Object.assign(new EventTarget(), { getWebContentsId: () => 41 })
            : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
      });
    });
    const cursor = () => renderer!.root.findByProps({ "data-agent-browser-cursor": true });
    expect(cursor().props.style.opacity).toBe(1);
    expect(cursor().props.style.transform).toBe("translate3d(69.5px, 66px, 0)");
    expect(useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.owner).toBe(owner);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await act(() => renderer!.update(render("human")));
    expect(cursor().props.style.opacity).toBe(0.18);
    mocks.activeRecordings.add(runtimeTabId);
    await act(() => renderer!.update(render("agent")));
    expect(renderer!.root.findAllByProps({ "data-agent-browser-cursor": true })).toHaveLength(0);
    mocks.activeRecordings.clear();
    await act(() => {
      surfaceStore.claim(runtimeTabId, Symbol("native-without-toolbar"), false, false);
      surfaceStore.present(
        runtimeTabId,
        useBrowserSurfaceStore.getState().byTabId[runtimeTabId]!.owner!,
        { x: 30, y: 50, width: 900, height: 700 },
        true,
        0,
        30,
      );
      renderer!.update(render("agent"));
    });
    expect(renderer!.root.findAllByProps({ "data-agent-browser-cursor": true })).toHaveLength(0);
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
          serverEpoch="epoch-1"
          initialUrl="https://example.com"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          remoteLive={false}
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

    expect(acquire).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
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
