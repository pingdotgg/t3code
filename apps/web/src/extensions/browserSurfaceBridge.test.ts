import { describe, it, expect, vi } from "vite-plus/test";
import {
  BROWSER_SESSIONS,
  BROWSER_SURFACE,
  BROWSER_SURFACE_Z_INDEX,
} from "@t3tools/extension-sdk/catalogue";

import type { BrowserSurfacePresentation } from "~/browser/browserSurfaceStore";
import { resolveHostedBrowserWebviewWrapperStyle } from "~/browser/hostedBrowserWebviewStyle";

import {
  createBrowserSurfaceBridge,
  type BrowserSurfaceBridgeDeps,
  type BrowserSurfaceBinding,
} from "./browserSurfaceBridge";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { shouldRenderPreviewMiniPlayer } from "~/components/ChatView.logic";
import { extensionPanelSurface } from "~/rightPanelStore";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { resourceKey } from "@t3tools/extension-sdk/contracts";

const context = {
  client: "web",
  resource: {
    namespace: "test.plugin",
    id: "view",
    environmentId: "env-a",
    projectId: "project-a",
    threadId: "thread-a",
  },
};
const sessionRef = { tabId: "tab-1", serverEpoch: "epoch-1" };

interface NativeLease {
  presents: {
    rect: unknown;
    visible: boolean;
    cornerRadius: number | undefined;
    zIndex: number | undefined;
  }[];
  released: boolean;
  stolenFlag: boolean;
  present(rect: unknown, visible: boolean, cornerRadius?: number, zIndex?: number): boolean;
  release(): void;
  stolen(): void;
}

function harness({
  composites = true,
  engineClaimPending = true,
}: {
  composites?: boolean;
  engineClaimPending?: boolean;
} = {}) {
  let previewState = {
    serverEpoch: "epoch-1" as string | null,
    sessions: { "tab-1": {} } as Record<string, unknown>,
    listSeq: 1,
    listFailures: 0,
  };
  let threadProjects: Record<string, string | null> = { "thread-a": "project-a" };
  let shellLive = true;
  const threadListeners = new Set<() => void>();
  const engineClaimListeners = new Set<() => void>();
  const sessionRefreshes: string[] = [];
  const deferred: { fn: () => void; ms: number; canceled: boolean }[] = [];
  const sessionListeners = new Set<() => void>();
  const storeListeners = new Set<
    (state: { readonly byTabId: Readonly<Record<string, BrowserSurfacePresentation>> }) => void
  >();
  const scheduled = new Set<() => void>();
  const syncMounts: string[] = [];
  const syncUnmounts: string[] = [];
  const nativeLeases: NativeLease[] = [];
  const nativeOwner = Symbol("native-owner");

  const deps: BrowserSurfaceBridgeDeps = {
    composites: () => composites,
    readEngineClaimPending: () => engineClaimPending,
    subscribeEngineClaims: (listener) => {
      engineClaimListeners.add(listener);
      return () => engineClaimListeners.delete(listener);
    },
    schedule: (flush) => {
      scheduled.add(flush);
      return () => scheduled.delete(flush);
    },
    mountSessionSync: (threadRef) => {
      const key = `${threadRef.environmentId}/${threadRef.threadId}`;
      syncMounts.push(key);
      return () => syncUnmounts.push(key);
    },
    readSessions: () => previewState as never,
    subscribeSessions: (_threadRef, listener) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    acquireNative: (_runtimeTabId) => {
      const lease: NativeLease = {
        presents: [],
        released: false,
        stolenFlag: false,
        present(rect, visible, cornerRadius, zIndex) {
          if (lease.released || lease.stolenFlag) return false;
          lease.presents.push({ rect, visible, cornerRadius, zIndex });
          return true;
        },
        release() {
          lease.released = true;
        },
        stolen() {
          lease.stolenFlag = true;
          for (const listener of storeListeners)
            listener({
              byTabId: {
                anything: { owner: Symbol("other") } as unknown as BrowserSurfacePresentation,
              },
            });
        },
      };
      nativeLeases.push(lease);
      return lease;
    },
    ownerOf: () => nativeOwner,
    subscribeStore: (listener) => {
      storeListeners.add(listener);
      return () => storeListeners.delete(listener);
    },
    resolveThreadScope: (threadRef) => ({
      projectId: threadProjects[threadRef.threadId] ?? null,
      authoritative: shellLive,
    }),
    subscribeThread: (_threadRef, listener) => {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
    refreshSessions: (threadRef) => {
      sessionRefreshes.push(`${threadRef.environmentId}/${threadRef.threadId}`);
    },
    defer: (fn, ms) => {
      const entry = { fn, ms, canceled: false };
      deferred.push(entry);
      return () => {
        entry.canceled = true;
      };
    },
  };
  const lifetime = new AbortController();
  const bind = createBrowserSurfaceBridge("env-a", deps);
  const host = (overrides: Partial<BrowserSurfaceBinding["grants"]> = {}) =>
    bind({
      grants: {
        capabilities: [BROWSER_SESSIONS, BROWSER_SURFACE],
        projectIds: ["project-a"],
        ...overrides,
      },
      lifetime: lifetime.signal,
    });
  return {
    host,
    lifetime,
    engineClaimListeners,
    setEngineClaimPending: (pending: boolean) => {
      engineClaimPending = pending;
      for (const listener of engineClaimListeners) listener();
    },
    deps,
    scheduled,
    flush: () => {
      const pending = Array.from(scheduled);
      scheduled.clear();
      for (const flush of pending) flush();
    },
    fireSessions: () => {
      for (const listener of sessionListeners) listener();
    },
    fireDeferred: () => {
      for (const entry of deferred) if (!entry.canceled) entry.fn();
    },
    deferred,
    fireThreads: () => {
      for (const listener of threadListeners) listener();
    },
    setPreviewState: (next: typeof previewState) => {
      previewState = next;
    },
    setThreadProject: (threadId: string, projectId: string | null) => {
      threadProjects = { ...threadProjects, [threadId]: projectId };
    },
    setShellLive: (live: boolean) => {
      shellLive = live;
    },
    sessionRefreshes,
    getPreviewState: () => previewState,
    sessionListeners,
    storeListeners,
    nativeLeases,
    syncMounts,
    syncUnmounts,
  };
}

describe("browserSurfaceBridge", () => {
  it("keeps the mini-player from superseding an async surface-2 lease after a reconnect remount", async () => {
    const setup = harness();
    const { acquireNative: _mockAcquire, ...deps } = setup.deps;
    useBrowserSurfaceStore.setState({
      activityByTabId: {},
      byTabId: {},
      extensionTargetsByResourceKey: {},
    });
    const bind = createBrowserSurfaceBridge("env-a", {
      ...deps,
      ownerOf: (runtimeTabId) =>
        useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.owner ?? null,
      subscribeStore: useBrowserSurfaceStore.subscribe,
    });
    const host = bind({
      grants: { capabilities: [BROWSER_SESSIONS, BROWSER_SURFACE], projectIds: ["project-a"] },
      lifetime: setup.lifetime.signal,
    });
    const threadRef = {
      environmentId: EnvironmentId.make("env-a"),
      threadId: ThreadId.make("thread-a"),
    };
    const panel = extensionPanelSurface(threadRef, {
      version: 1,
      surfaceId: "test.plugin/panel",
      placement: "side-panel",
      stateVersion: 1,
      restoreState: {},
      fallback: "Browser",
      context,
    });
    expect(panel).not.toBeNull();
    setup.setPreviewState({ serverEpoch: null, sessions: {}, listSeq: 0, listFailures: 0 });
    const session = { ...sessionRef, serverEpoch: "epoch-2" };
    const runtimeTabId = previewRuntimeTabId(threadRef, session.serverEpoch, session.tabId);
    const pending = host.acquire({ context, session });
    expect(useBrowserSurfaceStore.getState().byTabId[runtimeTabId]).toBeUndefined();
    expect(
      shouldRenderPreviewMiniPlayer({ kind: "browser", tabId: session.tabId }, panel, {
        extensionPanelOpen: true,
        requestedTabId:
          useBrowserSurfaceStore.getState().extensionTargetsByResourceKey[
            resourceKey(context.resource)
          ]?.tabId ?? null,
        browserSurface: undefined,
      }),
    ).toBe(false);
    setup.setPreviewState({
      serverEpoch: "epoch-2",
      sessions: { "tab-1": {} },
      listSeq: 1,
      listFailures: 0,
    });
    setup.fireSessions();
    const acquired = await pending;
    if (!acquired.ok) throw new Error("expected reconnect lease");
    try {
      const source = { kind: "browser", tabId: session.tabId } as const;
      const isFloating = (extensionPanelOpen = true) =>
        shouldRenderPreviewMiniPlayer(source, panel, {
          extensionPanelOpen,
          browserSurface: useBrowserSurfaceStore.getState().byTabId[runtimeTabId],
        });
      const owner = useBrowserSurfaceStore.getState().byTabId[runtimeTabId]!.owner;
      expect(isFloating()).toBe(false);
      expect(acquired.lease.present({ x: 0, y: 0, width: 900, height: 700 }, false)).toBe(
        "accepted",
      );
      setup.flush();
      expect(isFloating()).toBe(false);
      expect(isFloating(false)).toBe(true);
      expect(useBrowserSurfaceStore.getState().byTabId[runtimeTabId]!.owner).toBe(owner);
      expect(acquired.lease.state.kind).toBe("active");
    } finally {
      acquired.lease.release();
      useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
    }
  });

  it("does not claim progress for a compositing desktop on a remote environment", async () => {
    const h = harness({ engineClaimPending: false });
    const host = h.host();
    expect(host.presentation.supported).toBe(true);
    expect(host.engineClaimPending).toBe(false);
    const acquired = await host.acquire({ context, session: sessionRef });
    if (!acquired.ok) throw new Error("expected lease");
    expect(acquired.lease.state).toMatchObject({ kind: "active", engineClaimPending: false });
  });

  it("reports failed claims on the active lease without reacquiring or ending presentation", async () => {
    const h = harness();
    const host = h.host();
    expect(host.engineClaimPending).toBe(true);
    const acquired = await host.acquire({ context, session: sessionRef });
    if (!acquired.ok) throw new Error("expected lease");
    expect(acquired.lease.state).toMatchObject({ kind: "active", engineClaimPending: true });
    const changed = vi.fn();
    acquired.lease.onDidChangeState(changed);
    h.setEngineClaimPending(false);
    expect(acquired.lease.state).toMatchObject({
      kind: "active",
      presentation: { supported: true },
      engineClaimPending: false,
    });
    expect(changed).toHaveBeenCalledExactlyOnceWith(acquired.lease.state);
    expect(h.syncMounts).toEqual(["env-a/thread-a"]);
    expect(h.sessionRefreshes).toEqual([]);
    h.setEngineClaimPending(false);
    expect(changed).toHaveBeenCalledTimes(1);
    acquired.lease.release();
    expect(h.engineClaimListeners.size).toBe(0);
  });

  it("denies by name when a required grant is missing", async () => {
    const h = harness();
    const noSurface = h.host({ capabilities: [BROWSER_SESSIONS] });
    const denied = await noSurface.acquire({ context, session: sessionRef });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("expected denial");
    expect(denied.denial.reason).toBe("grant-denied");
    expect(denied.denial.grant).toBe(BROWSER_SURFACE);

    const noSessions = h.host({ capabilities: [BROWSER_SURFACE] });
    const denied2 = await noSessions.acquire({ context, session: sessionRef });
    expect(denied2.ok).toBe(false);
    if (denied2.ok) throw new Error("expected denial");
    expect(denied2.denial.grant).toBe(BROWSER_SESSIONS);
  });

  it("denies scopes outside this environment, non-thread scopes, and ungranted projects", async () => {
    const h = harness();
    const host = h.host();
    const wrongEnv = await host.acquire({
      context: { ...context, resource: { ...context.resource, environmentId: "env-b" } },
      session: sessionRef,
    });
    expect(wrongEnv.ok).toBe(false);
    if (!wrongEnv.ok) expect(wrongEnv.denial.reason).toBe("scope-invalid");

    const { threadId: _dropped, ...resourceWithoutThread } = context.resource;
    const noThread = await host.acquire({
      context: { ...context, resource: resourceWithoutThread },
      session: sessionRef,
    });
    expect(noThread.ok).toBe(false);
    if (!noThread.ok) expect(noThread.denial.reason).toBe("scope-invalid");

    const otherProject = h.host({ projectIds: ["project-b"] });
    const denied = await otherProject.acquire({ context, session: sessionRef });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.denial.reason).toBe("scope-invalid");
  });

  it("denies a granted project paired with a thread from another project", async () => {
    const h = harness();
    const host = h.host();
    h.setThreadProject("thread-a", "project-b");
    const denied = await host.acquire({ context, session: sessionRef });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.denial.reason).toBe("scope-invalid");
    expect(h.syncMounts).toEqual([]);

    h.setThreadProject("thread-a", null);
    const unknown = await host.acquire({ context, session: sessionRef });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.denial.reason).toBe("scope-invalid");
  });

  it("ends the lease when the thread's project is invalidated mid-lease", async () => {
    const h = harness();
    const acquired = await h.host().acquire({ context, session: sessionRef });
    if (!acquired.ok) throw new Error("expected lease");
    h.setThreadProject("thread-a", "project-b");
    h.fireThreads();
    expect(acquired.lease.state).toEqual({ kind: "ended", reason: "scope-invalidated" });
    expect(h.nativeLeases[0]?.released).toBe(true);
  });

  it("denies acquire while the shell is not authoritative", async () => {
    const h = harness();
    h.setShellLive(false);
    const denied = await h.host().acquire({ context, session: sessionRef });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.denial.reason).toBe("host-unavailable");
    expect(h.syncMounts).toEqual([]);
    expect(h.nativeLeases).toEqual([]);
  });

  it("holds the lease through a sync loss and re-validates when live", async () => {
    const h = harness();
    const acquired = await h.host().acquire({ context, session: sessionRef });
    if (!acquired.ok) throw new Error("expected lease");
    // Losing shell authority mid-lease is not evidence the thread moved.
    h.setShellLive(false);
    h.fireThreads();
    expect(acquired.lease.state).toMatchObject({
      kind: "active",
      presentation: { supported: true },
    });
    // Returning live with the same project keeps the claim…
    h.setShellLive(true);
    h.fireThreads();
    expect(acquired.lease.state).toMatchObject({
      kind: "active",
      presentation: { supported: true },
    });
    // …and returning live with the thread moved ends it.
    h.setThreadProject("thread-a", "project-b");
    h.fireThreads();
    expect(acquired.lease.state).toEqual({ kind: "ended", reason: "scope-invalidated" });
  });

  it("denies malformed session identity and checks mismatched epochs after sync", async () => {
    const h = harness();
    const host = h.host();
    const malformed = await host.acquire({ context, session: { tabId: "", serverEpoch: "e" } });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.denial.reason).toBe("session-invalid");

    h.setPreviewState({ serverEpoch: "epoch-2", sessions: {}, listSeq: 1, listFailures: 0 });
    const pending = host.acquire({ context, session: sessionRef });
    h.setPreviewState({ serverEpoch: "epoch-2", sessions: {}, listSeq: 2, listFailures: 0 });
    h.fireSessions();
    const stale = await pending;
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.denial.reason).toBe("epoch-changed");
    expect(h.sessionRefreshes).toEqual(["env-a/thread-a"]);
    expect(h.syncUnmounts).toEqual(["env-a/thread-a"]);
    expect(h.sessionListeners.size).toBe(0);
  });

  it.each([true, false])(
    "keeps sync mounted until a stale cache catches up (composites=%s)",
    async (composites) => {
      const h = harness({ composites });
      const host = h.host();
      const freshSession = { tabId: "tab-3", serverEpoch: "epoch-3" };
      h.setPreviewState({ serverEpoch: "epoch-2", sessions: {}, listSeq: 2, listFailures: 0 });
      expect(h.syncMounts).toEqual([]);

      const pending = host.acquire({ context, session: freshSession });
      expect(h.sessionRefreshes).toEqual(["env-a/thread-a"]);
      expect(
        useBrowserSurfaceStore.getState().extensionTargetsByResourceKey[
          resourceKey(context.resource)
        ]?.tabId,
      ).toBe(freshSession.tabId);
      expect(h.syncMounts).toEqual(["env-a/thread-a"]);
      expect(h.syncUnmounts).toEqual([]);
      expect(h.sessionListeners.size).toBe(1);
      expect(h.nativeLeases).toEqual([]);

      h.setPreviewState({
        serverEpoch: "epoch-3",
        sessions: { "tab-3": {} },
        listSeq: 3,
        listFailures: 0,
      });
      h.fireSessions();
      const acquired = await pending;
      if (!acquired.ok) throw new Error("expected refreshed session to acquire");
      expect(acquired.lease.state.kind).toBe("active");
      expect(h.syncMounts).toEqual(["env-a/thread-a"]);
      expect(h.sessionRefreshes).toEqual(["env-a/thread-a"]);
      acquired.lease.release();
      expect(h.syncUnmounts).toEqual(["env-a/thread-a"]);
      expect(h.sessionListeners.size).toBe(0);
    },
  );

  it("attaches on the same attempt when mounting reconciles a matching cached list", async () => {
    const h = harness();
    h.setPreviewState({ serverEpoch: "epoch-old", sessions: {}, listSeq: 1, listFailures: 0 });
    const bind = createBrowserSurfaceBridge("env-a", {
      ...h.deps,
      mountSessionSync: (ref) => {
        const unmount = h.deps.mountSessionSync(ref);
        h.setPreviewState({
          serverEpoch: sessionRef.serverEpoch,
          sessions: { [sessionRef.tabId]: {} },
          listSeq: 2,
          listFailures: 0,
        });
        return unmount;
      },
    });
    const host = bind({
      grants: { capabilities: [BROWSER_SESSIONS, BROWSER_SURFACE], projectIds: ["project-a"] },
      lifetime: h.lifetime.signal,
    });
    const acquired = await host.acquire({ context, session: sessionRef });
    if (!acquired.ok) throw new Error("expected the mounted cache to attach immediately");
    expect(h.deferred).toEqual([]);
    expect(h.sessionRefreshes).toEqual([]);
    expect(h.syncMounts).toEqual(["env-a/thread-a"]);
    acquired.lease.release();
  });

  it.each(["scope", "install", "deadline", "failure", "project"])(
    "cleans up pending attach without a native claim on %s",
    async (cause) => {
      const h = harness();
      h.setPreviewState({ serverEpoch: "epoch-old", sessions: {}, listSeq: 1, listFailures: 0 });
      const view = new AbortController();
      const pending = h.host().acquire({ context, session: sessionRef, signal: view.signal });
      if (cause === "scope") view.abort();
      else if (cause === "install") h.lifetime.abort();
      else if (cause === "deadline") h.fireDeferred();
      else {
        if (cause === "project") h.setThreadProject("thread-a", "project-b");
        h.setPreviewState({
          serverEpoch: sessionRef.serverEpoch,
          sessions: { [sessionRef.tabId]: {} },
          listSeq: cause === "failure" ? 1 : 2,
          listFailures: cause === "failure" ? 1 : 0,
        });
        h.fireSessions();
      }
      const acquired = await pending;
      expect(acquired.ok).toBe(false);
      if (acquired.ok) throw new Error("expected a canceled or failed attach");
      expect(acquired.denial.reason).toBe(
        cause === "scope" || cause === "project" ? "scope-invalid" : "host-unavailable",
      );
      expect(h.sessionListeners.size).toBe(0);
      expect(h.nativeLeases).toEqual([]);
      expect(h.syncUnmounts).toEqual(["env-a/thread-a"]);
      expect(h.deferred.every((entry) => entry.canceled)).toBe(true);
      expect(
        useBrowserSurfaceStore.getState().extensionTargetsByResourceKey[
          resourceKey(context.resource)
        ],
      ).toBeUndefined();
      expect(h.sessionRefreshes).toEqual(["env-a/thread-a"]);
    },
  );

  it.each(["scope", "install"])(
    "honors %s cancellation after sync resolves but before acquire resumes",
    async (cause) => {
      const h = harness();
      h.setPreviewState({ serverEpoch: "epoch-old", sessions: {}, listSeq: 1, listFailures: 0 });
      const view = new AbortController();
      const pending = h.host().acquire({ context, session: sessionRef, signal: view.signal });
      h.setPreviewState({
        serverEpoch: sessionRef.serverEpoch,
        sessions: { [sessionRef.tabId]: {} },
        listSeq: 2,
        listFailures: 0,
      });
      h.fireSessions();
      if (cause === "scope") view.abort();
      else h.lifetime.abort();
      const acquired = await pending;
      expect(acquired.ok).toBe(false);
      if (acquired.ok) throw new Error("expected a canceled attach");
      expect(acquired.denial.reason).toBe(cause === "scope" ? "scope-invalid" : "host-unavailable");
      expect(h.nativeLeases).toEqual([]);
      expect(h.syncUnmounts).toEqual(["env-a/thread-a"]);
      expect(h.sessionListeners.size).toBe(0);
      expect(h.deferred.every((entry) => entry.canceled)).toBe(true);
      expect(
        useBrowserSurfaceStore.getState().extensionTargetsByResourceKey[
          resourceKey(context.resource)
        ],
      ).toBeUndefined();
    },
  );

  it("coalesces present calls into one latest-wins native write per frame", async () => {
    const h = harness();
    const host = h.host();
    const acquired = await host.acquire({ context, session: sessionRef });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const lease = acquired.lease;
    expect(lease.state).toMatchObject({ kind: "active", presentation: { supported: true } });

    expect(lease.present({ x: 0, y: 0, width: 10, height: 10 }, true)).toBe("accepted");
    expect(lease.present({ x: 5, y: 5, width: 20, height: 20 }, false, 4, 7)).toBe("accepted");
    expect(h.nativeLeases[0]?.presents).toEqual([]);
    h.flush();
    expect(h.nativeLeases[0]?.presents).toEqual([
      { rect: { x: 5, y: 5, width: 20, height: 20 }, visible: false, cornerRadius: 4, zIndex: 7 },
    ]);
  });

  it("composites the webview at the contract layer, below plugin UI floating over the page", async () => {
    const h = harness();
    const acquired = await h.host().acquire({ context, session: sessionRef });
    if (!acquired.ok) throw new Error("expected a lease");
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    acquired.lease.present(rect, true);
    h.flush();
    const written = h.nativeLeases[0]?.presents[0];
    expect(written?.zIndex).toBe(BROWSER_SURFACE_Z_INDEX);
    // The engine host paints the webview wrapper at exactly the presented
    // layer, so plugin menus stacked above it (the SDK's overlayZIndex) win.
    const wrapper = resolveHostedBrowserWebviewWrapperStyle({
      active: true,
      renderingActive: true,
      rect,
      hiddenSize: { width: 10, height: 10 },
      ...(written?.zIndex === undefined ? {} : { zIndex: written.zIndex }),
    });
    expect(wrapper.zIndex).toBe(BROWSER_SURFACE_Z_INDEX);
  });

  it("keeps preview sync mounted for the lease lifetime and releases on release()", async () => {
    const h = harness();
    const acquired = await h.host().acquire({ context, session: sessionRef });
    expect(h.syncMounts).toEqual(["env-a/thread-a"]);
    if (!acquired.ok) return;
    const states: string[] = [];
    acquired.lease.onDidChangeState((state) => states.push(state.kind));
    acquired.lease.release();
    acquired.lease.release();
    expect(acquired.lease.state).toEqual({ kind: "ended", reason: "released" });
    expect(states).toEqual(["ended"]);
    expect(h.nativeLeases[0]?.released).toBe(true);
    expect(h.syncUnmounts).toEqual(["env-a/thread-a"]);
    expect(acquired.lease.present({ x: 0, y: 0, width: 1, height: 1 }, true)).toBe("ended");
  });

  it("supersedes a prior plugin lease on the same session", async () => {
    const h = harness();
    const first = await h.host().acquire({ context, session: sessionRef });
    const second = await h.host().acquire({ context, session: sessionRef });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.lease.state).toEqual({ kind: "ended", reason: "superseded" });
    expect(second.lease.state).toMatchObject({ kind: "active", presentation: { supported: true } });
    // The native lease stolen by the second acquire is also released.
    expect(h.nativeLeases[0]?.released).toBe(true);
  });

  it("ends the lease when the session disappears or the epoch moves", async () => {
    const h = harness();
    const acquired = await h.host().acquire({ context, session: sessionRef });
    if (!acquired.ok) throw new Error("expected lease");
    h.setPreviewState({ serverEpoch: "epoch-1", sessions: {}, listSeq: 2, listFailures: 0 });
    h.fireSessions();
    expect(acquired.lease.state).toEqual({ kind: "ended", reason: "session-closed" });

    h.setPreviewState({
      serverEpoch: "epoch-1",
      sessions: { "tab-1": {} },
      listSeq: 3,
      listFailures: 0,
    });
    const again = await h.host().acquire({ context, session: sessionRef });
    if (!again.ok) throw new Error("expected lease");
    h.setPreviewState({
      serverEpoch: "epoch-2",
      sessions: { "tab-1": {} },
      listSeq: 4,
      listFailures: 0,
    });
    h.fireSessions();
    expect(again.lease.state).toEqual({ kind: "ended", reason: "epoch-changed" });
  });

  it("ends a missing-session lease once a post-acquire list proves absence", async () => {
    const h = harness();
    // Warm sync: a list has already been applied and the tab is absent.
    h.setPreviewState({ serverEpoch: "epoch-1", sessions: {}, listSeq: 7, listFailures: 0 });
    const acquired = await h.host().acquire({ context, session: sessionRef });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    // The bridge forces a fresh list to arbitrate the absence.
    expect(h.sessionRefreshes).toEqual(["env-a/thread-a"]);
    // An unrelated event must not count as authority — the list seq is.
    h.fireSessions();
    expect(acquired.lease.state).toMatchObject({
      kind: "active",
      presentation: { supported: true },
    });
    // The post-acquire list landing without the tab is authoritative.
    h.setPreviewState({ serverEpoch: "epoch-1", sessions: {}, listSeq: 8, listFailures: 0 });
    h.fireSessions();
    expect(acquired.lease.state).toEqual({ kind: "ended", reason: "session-closed" });
  });

  it("keeps the open-before-sync race alive until the first list lands", async () => {
    const h = harness();
    // Cold sync: no list has ever been applied for this thread.
    h.setPreviewState({ serverEpoch: "epoch-1", sessions: {}, listSeq: 0, listFailures: 0 });
    const acquired = await h.host().acquire({ context, session: sessionRef });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    // The bridge always dispatches its own post-acquire arbitrating request.
    expect(h.sessionRefreshes).toEqual(["env-a/thread-a"]);
    // A list applied after acquire that contains the tab keeps the lease.
    h.setPreviewState({
      serverEpoch: "epoch-1",
      sessions: { "tab-1": {} },
      listSeq: 1,
      listFailures: 0,
    });
    h.fireSessions();
    expect(acquired.lease.state).toMatchObject({
      kind: "active",
      presentation: { supported: true },
    });
  });

  it("retries a failed arbitration inside the bound instead of ending early", async () => {
    const h = harness();
    // Warm sync: the tab is absent from applied state but unverified.
    h.setPreviewState({ serverEpoch: "epoch-1", sessions: {}, listSeq: 7, listFailures: 0 });
    const acquired = await h.host().acquire({ context, session: sessionRef });
    if (!acquired.ok) throw new Error("expected lease");
    expect(h.sessionRefreshes).toEqual(["env-a/thread-a"]);
    // A completed Failure is a completed attempt, not evidence of absence —
    // the lease stays active and a retry is dispatched within the bound.
    for (const failures of [1, 2]) {
      h.setPreviewState({
        serverEpoch: "epoch-1",
        sessions: {},
        listSeq: 7,
        listFailures: failures,
      });
      h.fireSessions();
      expect(acquired.lease.state).toMatchObject({
        kind: "active",
        presentation: { supported: true },
      });
    }
    expect(h.sessionRefreshes).toEqual(["env-a/thread-a", "env-a/thread-a", "env-a/thread-a"]);
    // Attempt bound reached — further failures only wait out the deadline.
    h.setPreviewState({ serverEpoch: "epoch-1", sessions: {}, listSeq: 7, listFailures: 3 });
    h.fireSessions();
    expect(h.sessionRefreshes).toHaveLength(3);
    expect(acquired.lease.state).toMatchObject({
      kind: "active",
      presentation: { supported: true },
    });
  });

  it("ends a never-verified lease at the arbitration deadline", async () => {
    const h = harness();
    h.setPreviewState({ serverEpoch: "epoch-1", sessions: {}, listSeq: 7, listFailures: 0 });
    const acquired = await h.host().acquire({ context, session: sessionRef });
    if (!acquired.ok) throw new Error("expected lease");
    // The arbitrating request never resolves — the bound ends it honestly.
    h.fireDeferred();
    expect(acquired.lease.state).toEqual({ kind: "ended", reason: "session-unverified" });
    expect(h.nativeLeases[0]?.released).toBe(true);
    expect(h.syncUnmounts).toEqual(["env-a/thread-a"]);
  });

  it("cancels the arbitration deadline once the session verifies", async () => {
    const h = harness();
    h.setPreviewState({ serverEpoch: "epoch-1", sessions: {}, listSeq: 7, listFailures: 0 });
    const acquired = await h.host().acquire({ context, session: sessionRef });
    if (!acquired.ok) throw new Error("expected lease");
    h.setPreviewState({
      serverEpoch: "epoch-1",
      sessions: { "tab-1": {} },
      listSeq: 8,
      listFailures: 0,
    });
    h.fireSessions();
    expect(h.deferred.every((entry) => entry.canceled)).toBe(true);
    h.fireDeferred();
    expect(acquired.lease.state).toMatchObject({
      kind: "active",
      presentation: { supported: true },
    });
  });

  it("ends the lease when the view signal aborts or the install lifetime ends", async () => {
    const h = harness();
    const view = new AbortController();
    const acquired = await h.host().acquire({ context, session: sessionRef, signal: view.signal });
    if (!acquired.ok) throw new Error("expected lease");
    view.abort();
    expect(acquired.lease.state).toEqual({ kind: "ended", reason: "scope-invalidated" });
    expect(h.nativeLeases[0]?.released).toBe(true);

    const second = await h.host().acquire({ context, session: sessionRef });
    if (!second.ok) throw new Error("expected lease");
    h.lifetime.abort();
    expect(second.lease.state).toEqual({ kind: "ended", reason: "grant-revoked" });
    // And new acquires fail once the install lifetime is over.
    const third = await h.host().acquire({ context, session: sessionRef });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.denial.reason).toBe("host-unavailable");
  });

  it("ends the lease when the native owner is stolen outside the bridge", async () => {
    const h = harness();
    const acquired = await h.host().acquire({ context, session: sessionRef });
    if (!acquired.ok) throw new Error("expected lease");
    h.nativeLeases[0]?.stolen();
    expect(acquired.lease.state).toEqual({ kind: "ended", reason: "superseded" });
  });

  it("reports the named uncomposited state on non-compositing clients", async () => {
    const h = harness({ composites: false });
    const host = h.host();
    expect(host.presentation).toEqual({ supported: false, reason: "desktop-required" });
    const acquired = await host.acquire({ context, session: sessionRef });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.lease.state).toMatchObject({
      kind: "active",
      presentation: { supported: false, reason: "desktop-required" },
    });
    expect(acquired.lease.present({ x: 0, y: 0, width: 10, height: 10 }, true)).toBe(
      "uncomposited",
    );
    // Still mounts sync so the session stays alive; never touches the native store.
    expect(h.nativeLeases).toEqual([]);
    expect(h.syncMounts).toEqual(["env-a/thread-a"]);
  });
});
