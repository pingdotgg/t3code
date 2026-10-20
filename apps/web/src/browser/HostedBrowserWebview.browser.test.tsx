import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import type { previewBridge } from "~/components/preview/previewBridge";

import { act, fakeTimers, render, stubGlobal } from "../../test/render";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  activeRecordings: new Set<string>(),
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

vi.mock(import("./desktopTabLifetime"), { spy: true });

// The Electron desktop bridge; a browser has none.
vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
  } as unknown as NonNullable<typeof previewBridge>,
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import * as desktopTabLifetime from "./desktopTabLifetime";
import { HostedBrowserWebview } from "./HostedBrowserWebview";

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function resetStores() {
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
}

function setup() {
  using stack = new DisposableStack();
  resetStores();
  stack.defer(resetStores);
  vi.mocked(desktopTabLifetime.acquireDesktopTab).mockClear();
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
  stack.use(vi.spyOn(console, "error").mockImplementation(() => undefined));
  return stack.move();
}

// The webview releases its desktop tab on a timer after unmount; run it before the test ends
// so it cannot land in the next one.
async function renderHost(ui: ReactNode) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(ui));
  stack.defer(async () => {
    using _timers = fakeTimers();
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(0);
  });
  const environment = stack.move();
  return Object.assign(screen, { [Symbol.asyncDispose]: () => environment.disposeAsync() });
}

describe("HostedBrowserWebview settings hydration", () => {
  it("starts a retained background tab only after a settings read succeeds on retry", async () => {
    using _setup = setup();
    const firstRead = deferred<ClientSettings | null>();
    const retryRead = deferred<ClientSettings | null>();
    const tabCreation = deferred<void>();
    mocks.getClientSettings
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(retryRead.promise);
    mocks.createTab.mockReturnValueOnce(tabCreation.promise);
    const acquire = vi.mocked(desktopTabLifetime.acquireDesktopTab);
    // Chromium treats <webview> as an unknown element; give it the one Electron method the
    // host calls once the guest attaches.
    const createElement = document.createElement.bind(document);
    using createGuest = vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions,
    ) => {
      const element = createElement(tagName, options);
      return tagName === "webview"
        ? Object.assign(element, { getWebContentsId: () => 41 })
        : element;
    }) as typeof document.createElement);
    const guests = () => createGuest.mock.calls.filter(([tagName]) => tagName === "webview");
    const guest = () => screen.container.querySelector("webview");
    const threadRef = {
      environmentId: EnvironmentId.make("host-settings-retry"),
      threadId: ThreadId.make("thread-settings-retry"),
    };
    const runtimeTabId = "retained-background-tab";
    useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);

    await using screen = await renderHost(
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
    );

    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(guest()).toBeNull();
    expect(mocks.createTab).not.toHaveBeenCalled();

    const failure = new Error("Saved settings are unavailable");
    await act(async () => {
      const hydration = ensureClientSettingsHydrated();
      firstRead.reject(failure);
      await expect(hydration).rejects.toBe(failure);
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(guest()).toBeNull();
    expect(mocks.createTab).not.toHaveBeenCalled();

    let retry!: Promise<void>;
    await act(() => {
      retry = ensureClientSettingsHydrated();
    });
    expect(mocks.getClientSettings).toHaveBeenCalledTimes(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(guest()).toBeNull();
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
    expect(guests()).toHaveLength(1);
    expect(guest()?.getAttribute("partition")).toBe("persist:t3-preview-work");
    expect(guest()?.getAttribute("src")).toBe("https://example.com");
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

describe("HostedBrowserWebview viewport layout", () => {
  const runtimeTabId = "zoom-layout-tab";
  const owner = Symbol("panel");
  const panel = { x: 0, y: 0, width: 2000, height: 1600 };

  const webview = (viewport: PreviewViewportSetting) => (
    <HostedBrowserWebview
      threadRef={{
        environmentId: EnvironmentId.make("zoom-layout"),
        threadId: ThreadId.make("zoom-layout"),
      }}
      tabId="zoom-layout"
      runtimeTabId={runtimeTabId}
      initialUrl="about:blank"
      viewport={viewport}
      pictureInPicture={false}
      profileId={undefined}
      zoomFactor={1.5}
    />
  );

  async function renderViewport(viewport: PreviewViewportSetting) {
    mocks.getClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      browserDefaultZoomFactor: 1.5,
    });
    await act(() => ensureClientSettingsHydrated());
    await using stack = new AsyncDisposableStack();
    const screen = stack.use(await renderHost(webview(viewport)));
    const guest = screen.container.querySelector("webview");
    expect(guest).not.toBeNull();
    const environment = stack.move();
    return Object.assign(screen, {
      guest: guest!,
      setViewport: (next: PreviewViewportSetting) => screen.rerender(webview(next)),
      [Symbol.asyncDispose]: () => environment.disposeAsync(),
    });
  }

  it("keeps fixed viewports sized in guest pixels across host zoom and fitted surfaces", async () => {
    using _setup = setup();
    let windowZoom = 1.25;
    using _bridge = stubGlobal("desktopBridge", { getWindowZoomFactor: () => windowZoom });
    useBrowserSurfaceStore.getState().claim(runtimeTabId, owner, false);
    useBrowserSurfaceStore.getState().present(runtimeTabId, owner, panel, true, 0, 30);
    await using screen = await renderViewport({ _tag: "freeform", width: 800, height: 600 });
    const { guest } = screen;
    expect(guest.getBoundingClientRect()).toMatchObject({ width: 960, height: 720 });

    windowZoom = 0.75;
    await act(() => window.dispatchEvent(new Event("resize")));
    expect(guest.getBoundingClientRect()).toMatchObject({ width: 1600, height: 1200 });

    windowZoom = 1;
    await act(() => window.dispatchEvent(new Event("resize")));
    expect(guest.getBoundingClientRect()).toMatchObject({ width: 1200, height: 900 });

    windowZoom = 1.25;
    await act(() => window.dispatchEvent(new Event("resize")));
    await screen.setViewport({ _tag: "preset", presetId: "iphone-se", width: 375, height: 667 });
    expect(guest.getBoundingClientRect().width).toBe(450);
    expect(guest.getBoundingClientRect().height).toBeCloseTo(800.4, 1);

    const miniPlayer = Symbol("mini-player");
    await act(() => {
      useBrowserSurfaceStore.getState().claim(runtimeTabId, miniPlayer, true);
      useBrowserSurfaceStore
        .getState()
        .present(runtimeTabId, miniPlayer, { x: 0, y: 0, width: 225, height: 401 }, true, 0, 48);
    });
    expect(guest.offsetWidth).toBe(450);
    expect(guest.offsetHeight).toBe(800);
    expect(guest.getBoundingClientRect().width).toBe(225);
    expect(guest.getBoundingClientRect().height).toBeCloseTo(400.2, 1);

    await act(() => {
      useBrowserSurfaceStore.getState().claim(runtimeTabId, owner, false);
      useBrowserSurfaceStore.getState().present(runtimeTabId, owner, panel, true, 0, 30);
    });
    await screen.setViewport(FILL_PREVIEW_VIEWPORT);
    expect(guest.getBoundingClientRect()).toMatchObject({ width: 2000, height: 1600 });
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId, {
      zoomFactor: 1.5,
      colorScheme: DEFAULT_CLIENT_SETTINGS.browserDefaultAppearance,
    });
  });

  it("preserves preview scaling with an older bridge or no desktop bridge", async () => {
    using _setup = setup();
    using _bridge = stubGlobal("desktopBridge", {});
    await using screen = await renderViewport({ _tag: "freeform", width: 800, height: 600 });
    const { guest } = screen;
    expect(guest.getBoundingClientRect()).toMatchObject({ width: 1200, height: 900 });

    // `_bridge` puts the original back after the unmount, so the unmount still sees no bridge.
    Reflect.set(globalThis, "desktopBridge", undefined);
    await act(() => window.dispatchEvent(new Event("resize")));
    expect(guest.getBoundingClientRect()).toMatchObject({ width: 1200, height: 900 });
  });
});
