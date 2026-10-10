import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type PreviewEvent,
  type PreviewListResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { Effect } from "effect";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
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
    setColorScheme: async () => undefined,
    setZoomFactor: async () => undefined,
  },
}));

vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make("desktop-primary") };
});
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    events: ({ environmentId }: { environmentId: string }) => previewEventsFor(environmentId),
    list: ({ environmentId, input }: { environmentId: string; input: { threadId?: string } }) => {
      if (input.threadId === undefined) return previewList;
      const ref = scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(input.threadId));
      return threadListQueries.get(scopedThreadKey(ref)) ?? threadListValues(scopedThreadKey(ref));
    },
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
import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import { previewStateAtom, resetPreviewStateForTests } from "~/previewStateStore";
import { usePreviewSession } from "~/components/preview/usePreviewSession";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";

const previewEvents = new Map<
  string,
  Atom.Writable<AsyncResult.AsyncResult<PreviewEvent>, AsyncResult.AsyncResult<PreviewEvent>>
>();
const previewList = Atom.make<AsyncResult.AsyncResult<PreviewListResult>>(AsyncResult.initial());
const threadListValues = Atom.family((_threadKey: string) =>
  Atom.make<AsyncResult.AsyncResult<PreviewListResult>>(AsyncResult.initial()),
);
const threadListQueries = new Map<string, Atom.Atom<AsyncResult.AsyncResult<PreviewListResult>>>();
function previewEventsFor(environmentId: string) {
  let atom = previewEvents.get(environmentId);
  if (!atom) {
    atom = Atom.make<AsyncResult.AsyncResult<PreviewEvent>>(AsyncResult.initial());
    previewEvents.set(environmentId, atom);
  }
  return atom;
}

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
  resetPreviewStateForTests();
  threadListQueries.clear();
  appAtomRegistry.set(previewList, AsyncResult.initial());
  for (const atom of previewEvents.values()) appAtomRegistry.set(atom, AsyncResult.initial());
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
  vi.stubGlobal("document", { documentElement: {}, head: {} });
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("Electron browser hosting outside the selected thread", () => {
  it("applies primary events once and ignores retired lists while remote epochs advance", async () => {
    const local = {
      environmentId: EnvironmentId.make("desktop-primary"),
      threadId: ThreadId.make("selected-thread"),
    };
    const remote = { ...local, environmentId: EnvironmentId.make("remote-server") };
    function ChatSync() {
      usePreviewSession(local);
      usePreviewSession(remote);
      return null;
    }
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await act(async () => {
      await ensureClientSettingsHydrated();
      renderer = create(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
          <ChatSync />
        </AppAtomRegistryProvider>,
        {
          createNodeMock: (element) =>
            element.type === "webview"
              ? Object.assign(new EventTarget(), { getWebContentsId: () => 44 })
              : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
        },
      );
    });
    const applied = vi.fn();
    const stop = appAtomRegistry.subscribe(previewStateAtom(scopedThreadKey(local)), (state) => {
      if (state.sessions["selected-tab"]) applied();
    });
    const opened: PreviewEvent = {
      type: "opened",
      threadId: local.threadId,
      tabId: "selected-tab",
      serverEpoch: "server",
      revision: 1,
      createdAt: "2026-10-07T00:00:00.000Z",
      snapshot: {
        threadId: local.threadId,
        tabId: "selected-tab",
        runtime: "server",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-07T00:00:00.000Z",
      },
    };
    try {
      await act(() => {
        appAtomRegistry.set(previewEventsFor(local.environmentId), AsyncResult.success(opened));
        appAtomRegistry.set(previewEventsFor(remote.environmentId), AsyncResult.success(opened));
      });
      expect(applied).toHaveBeenCalledOnce();
      expect(appAtomRegistry.get(previewStateAtom(scopedThreadKey(remote))).sessions).toEqual({
        "selected-tab": opened.snapshot,
      });
      expect(mocks.createTab).toHaveBeenCalledOnce();

      await act(() => {
        appAtomRegistry.set(
          threadListValues(scopedThreadKey(local)),
          AsyncResult.success({
            serverEpoch: "retired-server",
            revision: 100,
            sessions: [{ ...opened.snapshot, tabId: "retired-tab" }],
          }),
        );
      });
      expect(appAtomRegistry.get(previewStateAtom(scopedThreadKey(local)))).toMatchObject({
        serverEpoch: opened.serverEpoch,
        sessions: { "selected-tab": opened.snapshot },
      });
      expect(applied).toHaveBeenCalledOnce();
      expect(mocks.createTab).toHaveBeenCalledOnce();

      const remoteSnapshot = { ...opened.snapshot, tabId: "remote-restarted-tab" };
      await act(() => {
        appAtomRegistry.set(
          threadListValues(scopedThreadKey(remote)),
          AsyncResult.success({
            serverEpoch: "restarted-remote-server",
            revision: 1,
            sessions: [remoteSnapshot],
          }),
        );
      });
      expect(appAtomRegistry.get(previewStateAtom(scopedThreadKey(remote)))).toMatchObject({
        serverEpoch: "restarted-remote-server",
        sessions: { "remote-restarted-tab": remoteSnapshot },
      });
    } finally {
      stop();
    }
  });

  it("refreshes the mounted chat's separate query when the host list adopts a new epoch", async () => {
    const threadRef = scopeThreadRef(
      EnvironmentId.make("desktop-primary"),
      ThreadId.make("epoch-refresh-thread"),
    );
    const oldRead = deferred<PreviewListResult>();
    const freshRead = deferred<PreviewListResult>();
    let restarted = false;
    threadListQueries.set(
      scopedThreadKey(threadRef),
      Atom.make(() => Effect.promise(() => (restarted ? freshRead.promise : oldRead.promise))),
    );
    function ChatSync() {
      usePreviewSession(threadRef);
      return null;
    }
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await act(async () => {
      await ensureClientSettingsHydrated();
      renderer = create(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
          <ChatSync />
        </AppAtomRegistryProvider>,
        {
          createNodeMock: (element) =>
            element.type === "webview"
              ? Object.assign(new EventTarget(), { getWebContentsId: () => 45 })
              : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
        },
      );
    });
    const oldSnapshot: PreviewListResult["sessions"][number] = {
      threadId: threadRef.threadId,
      tabId: "before-restart",
      runtime: "server",
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-10-07T00:00:00.000Z",
    };
    await act(async () => {
      oldRead.resolve({ serverEpoch: "server-before", revision: 5, sessions: [oldSnapshot] });
      await oldRead.promise;
    });
    expect(mocks.createTab).toHaveBeenCalledOnce();
    restarted = true;
    await act(() => {
      appAtomRegistry.set(
        previewList,
        AsyncResult.success({ serverEpoch: "server-after", revision: 1, sessions: [] }),
      );
    });
    const freshSnapshot = { ...oldSnapshot, tabId: "after-restart" };
    await act(async () => {
      freshRead.resolve({ serverEpoch: "server-after", revision: 2, sessions: [freshSnapshot] });
      await freshRead.promise;
    });
    expect(appAtomRegistry.get(previewStateAtom(scopedThreadKey(threadRef)))).toMatchObject({
      serverEpoch: "server-after",
      sessions: { "after-restart": freshSnapshot },
      listLoaded: true,
    });
    expect(mocks.createTab).toHaveBeenLastCalledWith(
      previewRuntimeTabId(threadRef, "server-after", freshSnapshot.tabId),
      expect.objectContaining({
        serverTab: { threadId: threadRef.threadId, tabId: freshSnapshot.tabId },
      }),
    );
  });

  it("attaches existing tabs from the initial list and reconciles a reconnect without events", async () => {
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await act(async () => {
      await ensureClientSettingsHydrated();
      renderer = create(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
        </AppAtomRegistryProvider>,
        {
          createNodeMock: (element) =>
            element.type === "webview"
              ? Object.assign(new EventTarget(), { getWebContentsId: () => 43 })
              : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
        },
      );
    });
    const threadRef = {
      environmentId: EnvironmentId.make("desktop-primary"),
      threadId: ThreadId.make("already-open"),
    };
    const initialList: PreviewListResult = {
      serverEpoch: "existing-server",
      revision: 1,
      sessions: [
        {
          threadId: threadRef.threadId,
          tabId: "existing-tab",
          runtime: "server",
          navStatus: { _tag: "Idle" },
          canGoBack: false,
          canGoForward: false,
          updatedAt: "2026-10-06T00:00:00.000Z",
        },
      ],
    };
    await act(() => {
      appAtomRegistry.set(previewList, AsyncResult.success(initialList));
    });
    const runtimeTabId = previewRuntimeTabId(threadRef, initialList.serverEpoch, "existing-tab");
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(
      runtimeTabId,
      expect.objectContaining({
        serverTab: { threadId: threadRef.threadId, tabId: "existing-tab" },
      }),
    );
    expect(mocks.registerWebview).toHaveBeenCalledExactlyOnceWith(runtimeTabId, 43);

    vi.useFakeTimers();
    await act(() => {
      appAtomRegistry.set(previewList, AsyncResult.success(initialList, { waiting: true }));
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.closeTab).not.toHaveBeenCalled();
    await act(() => {
      appAtomRegistry.set(
        previewList,
        AsyncResult.success({ ...initialList, revision: 2, sessions: [] }),
      );
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.closeTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
  });

  it("attaches a primary-server tab without a chat view and releases it when closed", async () => {
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await act(async () => {
      await ensureClientSettingsHydrated();
      renderer = create(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
        </AppAtomRegistryProvider>,
        {
          createNodeMock: (element) =>
            element.type === "webview"
              ? Object.assign(new EventTarget(), { getWebContentsId: () => 42 })
              : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
        },
      );
    });
    const threadRef = {
      environmentId: EnvironmentId.make("desktop-primary"),
      threadId: ThreadId.make("background-agent"),
    };
    const opened: PreviewEvent = {
      type: "opened",
      threadId: threadRef.threadId,
      tabId: "background-tab",
      serverEpoch: "primary-server",
      revision: 1,
      createdAt: "2026-10-06T00:00:00.000Z",
      snapshot: {
        threadId: threadRef.threadId,
        tabId: "background-tab",
        runtime: "server",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-06T00:00:00.000Z",
      },
    };
    await act(() => {
      appAtomRegistry.set(
        previewEventsFor(threadRef.environmentId),
        AsyncResult.success(opened, { waiting: true }),
      );
    });
    const runtimeTabId = previewRuntimeTabId(threadRef, opened.serverEpoch, opened.tabId);
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId, {
      zoomFactor: DEFAULT_CLIENT_SETTINGS.browserDefaultZoomFactor,
      colorScheme: DEFAULT_CLIENT_SETTINGS.browserDefaultAppearance,
      serverTab: { threadId: threadRef.threadId, tabId: opened.tabId },
    });
    expect(mocks.registerWebview).toHaveBeenCalledExactlyOnceWith(runtimeTabId, 42);

    // Separate threads can open tabs before React paints again. The stream
    // subscriber must retain both, and must not subscribe to remote environments.
    await act(() => {
      for (const suffix of ["b", "c"]) {
        const threadId = `background-${suffix}`;
        const tabId = `tab-${suffix}`;
        appAtomRegistry.set(
          previewEventsFor(threadRef.environmentId),
          AsyncResult.success(
            {
              ...opened,
              threadId,
              tabId,
              revision: suffix === "b" ? 2 : 3,
              snapshot: { ...opened.snapshot, threadId, tabId },
            },
            { waiting: true },
          ),
        );
      }
      appAtomRegistry.set(previewEventsFor("remote-server"), AsyncResult.success(opened));
    });
    expect(mocks.createTab).toHaveBeenCalledTimes(3);
    expect(mocks.registerWebview).toHaveBeenCalledTimes(3);

    vi.useFakeTimers();
    await act(() => {
      appAtomRegistry.set(
        previewEventsFor(threadRef.environmentId),
        AsyncResult.success({ ...opened, type: "closed", revision: 4 }, { waiting: true }),
      );
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.closeTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId);

    await act(() => {
      appAtomRegistry.set(
        previewEventsFor(threadRef.environmentId),
        AsyncResult.success(
          {
            ...opened,
            serverEpoch: "restarted-primary-server",
            revision: 1,
          },
          { waiting: true },
        ),
      );
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.closeTab).toHaveBeenCalledTimes(3);
    for (const suffix of ["b", "c"]) {
      expect(mocks.closeTab).toHaveBeenCalledWith(
        previewRuntimeTabId(
          { ...threadRef, threadId: ThreadId.make(`background-${suffix}`) },
          opened.serverEpoch,
          `tab-${suffix}`,
        ),
      );
    }
    expect(mocks.createTab).toHaveBeenLastCalledWith(
      previewRuntimeTabId(threadRef, "restarted-primary-server", opened.tabId),
      expect.objectContaining({ serverTab: { threadId: threadRef.threadId, tabId: opened.tabId } }),
    );
    expect(mocks.registerWebview).toHaveBeenCalledTimes(4);
  });
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
