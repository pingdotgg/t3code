import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
}));

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

// The Electron desktop bridge; a browser has none.
vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
  } as never,
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));

// Stands in for a primary environment, whose server tabs the desktop renders natively.
vi.mock(import("./previewRuntime"), async (original) => ({
  ...(await original()),
  rendersServerTabNatively: (_environmentId, _primaryEnvironmentId, snapshot) =>
    snapshot?.runtime === "server",
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { reconcilePreviewServerSessions, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { acquireBrowserSurface, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

const threadRef = scopeThreadRef(
  EnvironmentId.make("host-webview-order"),
  ThreadId.make("thread-webview-order"),
);

const snapshot = (
  tabId: string,
  updatedAt: string,
  overrides: Partial<PreviewSessionSnapshot> = {},
): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Loading", url: `https://example.com/${tabId}`, title: tabId },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
  ...overrides,
});

const loaded = (url: string) => ({
  navStatus: { _tag: "Success" as const, url, title: url },
});

const PANEL_RECT = { x: 0, y: 0, width: 800, height: 600 };

/** Shows the tab in a visible preview panel; setup() clears it. */
function showTab(tabId: string) {
  const surface = acquireBrowserSurface(previewRuntimeTabId(threadRef, "server-a", tabId));
  surface.present(PANEL_RECT, true);
  return surface;
}

function setup(): Disposable {
  __resetClientSettingsPersistenceForTests();
  mocks.getClientSettings.mockReset().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-default",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  return {
    [Symbol.dispose]() {
      resetPreviewStateForTests();
      useBrowserSurfaceStore.setState({ byTabId: {}, activityByTabId: {} });
      __resetClientSettingsPersistenceForTests();
    },
  };
}

async function renderHost() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <AppAtomRegistryProvider>
        <ElectronBrowserHost />
      </AppAtomRegistryProvider>,
    ),
  );
  // Unmounting releases each tab on a close timer; run it now so it never fires in a later test.
  stack.defer(async () => {
    using _timers = fakeTimers();
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(() => ensureClientSettingsHydrated());
  const environment = stack.move();
  return { container: screen.container, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}

describe("ElectronBrowserHost", () => {
  it("never moves a tab's webview when the server reorders tabs by last update", async () => {
    using _state = setup();
    reconcilePreviewServerSessions(threadRef, {
      sessions: [
        snapshot("tab_7", "2026-01-01T00:00:01.000Z"),
        snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
      ],
      serverEpoch: "server-a",
      revision: 1,
    });
    await using screen = await renderHost();

    const host = screen.container.querySelector("[data-electron-browser-host]")!;
    const webviews = () => [...host.querySelectorAll("webview")];
    const before = webviews();
    expect(before.map((node) => node.getAttribute("data-preview-server-tab")).toSorted()).toEqual([
      "tab_7",
      "tab_8",
    ]);

    // Electron destroys a webview's guest when its element leaves the DOM, so a reorder that
    // detaches and re-inserts the element blanks the tab.
    const detached: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) detached.push(...record.removedNodes);
    });
    observer.observe(host, { childList: true, subtree: true });

    await act(async () => {
      reconcilePreviewServerSessions(threadRef, {
        sessions: [
          snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
          snapshot("tab_7", "2026-01-01T00:00:03.000Z"),
        ],
        serverEpoch: "server-a",
        revision: 2,
      });
    });
    observer.takeRecords().forEach((record) => detached.push(...record.removedNodes));
    observer.disconnect();

    expect(detached).toEqual([]);
    const after = webviews();
    expect(after).toHaveLength(2);
    expect(after.every((node, index) => node.isSameNode(before[index]!))).toBe(true);
  });

  it("drops a hidden desktop tab's guest after ten minutes and reloads its page when shown", async () => {
    using _state = setup();
    reconcilePreviewServerSessions(threadRef, {
      sessions: [
        snapshot("tab_desktop", "2026-01-01T00:00:01.000Z"),
        snapshot("tab_agent_1", "2026-01-01T00:00:02.000Z", { runtime: "server" }),
      ],
      serverEpoch: "server-a",
      revision: 1,
    });
    await using screen = await renderHost();
    const guestOf = (tabId: string) =>
      screen.container.querySelector(`webview[data-preview-server-tab="${tabId}"]`);
    const panel = await act(() => showTab("tab_desktop"));
    using _timers = fakeTimers();
    await act(() => panel.present(PANEL_RECT, false));
    const firstGuest = guestOf("tab_desktop");
    expect(firstGuest).not.toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000 - 1));
    expect(guestOf("tab_desktop")).toBe(firstGuest);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(guestOf("tab_desktop")).toBeNull();
    // The agent's server tab is the server browser's to close.
    expect(guestOf("tab_agent_1")).not.toBeNull();

    await act(() => {
      reconcilePreviewServerSessions(threadRef, {
        sessions: [
          snapshot("tab_desktop", "2026-01-01T00:00:03.000Z", loaded("https://example.com/next")),
          snapshot("tab_agent_1", "2026-01-01T00:00:02.000Z", { runtime: "server" }),
        ],
        serverEpoch: "server-a",
        revision: 2,
      });
      panel.present(PANEL_RECT, true);
    });
    expect(guestOf("tab_desktop")?.getAttribute("src")).toBe("https://example.com/next");
  });

  it("waits until a hidden tab whose page already loaded is shown to load it", async () => {
    using _state = setup();
    reconcilePreviewServerSessions(threadRef, {
      sessions: [
        snapshot("tab_loaded", "2026-01-01T00:00:01.000Z", loaded("https://example.com/loaded")),
      ],
      serverEpoch: "server-a",
      revision: 1,
    });
    await using screen = await renderHost();
    const guest = () =>
      screen.container.querySelector('webview[data-preview-server-tab="tab_loaded"]');
    expect(guest()).toBeNull();

    await act(() => showTab("tab_loaded"));
    expect(guest()?.getAttribute("src")).toBe("https://example.com/loaded");
  });
});
