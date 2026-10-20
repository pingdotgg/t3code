import {
  EnvironmentId,
  ThreadId,
  type PreviewEvent,
  type PreviewListResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

// Only the transport is substituted. The hook, atom registry and preview
// store run unchanged, including lazy evaluation and refresh notifications.
type ListResult = AsyncResult.AsyncResult<PreviewListResult, never>;
type EventResult = AsyncResult.AsyncResult<PreviewEvent, never>;
const harness = vi.hoisted(() => ({
  lists: new Map<
    string,
    {
      box: { current: ListResult; requests: number };
      atom: Atom.Writable<ListResult>;
    }
  >(),
  events: new Map<string, Atom.Writable<EventResult>>(),
}));

vi.mock("~/env", () => ({ isElectron: true }));

vi.mock("~/state/preview", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    previewEnvironment: {
      list: (target: { input: { threadId: string } }) => {
        const key = target.input.threadId;
        let entry = harness.lists.get(key);
        if (!entry) {
          const box: { current: ListResult; requests: number } = {
            current: AsyncResult.initial(),
            requests: 0,
          };
          const atom = Atom.writable(
            () => {
              box.requests += 1;
              return AsyncResult.waiting(box.current);
            },
            (ctx, value: ListResult) => {
              box.current = value;
              ctx.setSelf(value);
            },
          );
          entry = { box, atom };
          harness.lists.set(key, entry);
        }
        return entry.atom;
      },
      events: (target: { environmentId: string }) => {
        let atom = harness.events.get(target.environmentId);
        if (!atom) {
          atom = Atom.make<EventResult>(AsyncResult.initial());
          harness.events.set(target.environmentId, atom);
        }
        return atom;
      },
    },
  };
});

import {
  applyPreviewServerSnapshot,
  applyPreviewDesktopState,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import { useDesktopHostedPreviewSessions, usePreviewSession } from "./usePreviewSession";

function setup() {
  harness.lists.clear();
  harness.events.clear();
  resetPreviewStateForTests();
  // The app atom registry outlives each test, so every test gets its own environment and thread.
  const testName = expect.getState().currentTestName!;
  const ref: ScopedThreadRef = {
    environmentId: EnvironmentId.make(`preview-sync ${testName}`),
    threadId: ThreadId.make(`thread-sync ${testName}`),
  };

  const listAtom = () => {
    previewEnvironment.list({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId },
    });
    return harness.lists.get(ref.threadId)!.atom;
  };
  const result = (
    revision: number,
    tabIds: string[],
    serverEpoch = "epoch-1",
  ): PreviewListResult => ({
    serverEpoch,
    revision,
    sessions: tabIds.map((tabId) => ({
      threadId: ref.threadId,
      tabId,
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-10-02T00:00:00.000Z",
    })),
  });

  function SessionSync() {
    usePreviewSession(ref);
    return null;
  }
  function DesktopSessionSync() {
    useDesktopHostedPreviewSessions(ref.environmentId);
    return null;
  }
  // The session hooks render nothing and never read or change the route.
  const mount = (Component: () => null = SessionSync) =>
    render(createElement(AppAtomRegistryProvider, null, createElement(Component)), {
      router: false,
    });

  return {
    ref,
    listAtom,
    result,
    mount,
    DesktopSessionSync,
    [Symbol.dispose]: () => resetPreviewStateForTests(),
  };
}

describe("native preview session synchronization", () => {
  it("discovers and closes a server tab in a background thread without mounting its chat", async () => {
    using sync = setup();
    const { ref, listAtom, result } = sync;
    await using _screen = await sync.mount(sync.DesktopSessionSync);
    expect(readThreadPreviewState(ref).sessions).toEqual({});
    previewEnvironment.events({ environmentId: ref.environmentId, input: {} });
    const events = harness.events.get(ref.environmentId)!;
    const baseline = result(1, ["agent-tab"]);
    const snapshot = baseline.sessions[0]!;
    await act(async () => {
      appAtomRegistry.set(
        events,
        AsyncResult.success({
          type: "opened",
          threadId: ref.threadId,
          tabId: snapshot.tabId,
          snapshot,
          serverEpoch: baseline.serverEpoch,
          revision: baseline.revision,
          createdAt: snapshot.updatedAt,
        }),
      );
    });
    expect(readThreadPreviewState(ref).sessions).toEqual({ "agent-tab": snapshot });
    appAtomRegistry.set(listAtom(), AsyncResult.success(baseline));
    expect(readThreadPreviewState(ref).listLoaded).toBe(true);
    expect(readThreadPreviewState(ref).snapshot).toEqual(snapshot);

    appAtomRegistry.set(
      events,
      AsyncResult.success({
        type: "closed",
        threadId: ref.threadId,
        tabId: snapshot.tabId,
        serverEpoch: baseline.serverEpoch,
        revision: 2,
        createdAt: snapshot.updatedAt,
      }),
    );
    expect(readThreadPreviewState(ref).sessions).toEqual({});
    expect(readThreadPreviewState(ref).activeTabId).toBeNull();
  });

  it("evaluates the lazy list once and restores sessions that predate mounting", async () => {
    using sync = setup();
    const { ref, listAtom, result } = sync;
    const atom = listAtom();
    await using _screen = await sync.mount();
    expect(harness.lists.get(ref.threadId)?.box.requests).toBe(1);
    appAtomRegistry.set(atom, AsyncResult.success(result(1, ["restored"])));
    expect(readThreadPreviewState(ref).activeTabId).toBe("restored");
  });

  it("preserves a local tab while cached absence is waiting for a fresh response", async () => {
    using sync = setup();
    const { ref, listAtom, result } = sync;
    const atom = listAtom();
    appAtomRegistry.set(atom, AsyncResult.waiting(AsyncResult.success(result(1, []))));
    applyPreviewServerSnapshot(ref, result(1, ["local"]).sessions[0]!);
    await using _screen = await sync.mount();
    expect(readThreadPreviewState(ref).activeTabId).toBe("local");
    expect(harness.lists.get(ref.threadId)?.box.requests).toBe(0);
    appAtomRegistry.set(atom, AsyncResult.success(result(2, ["local"])));
    expect(readThreadPreviewState(ref).activeTabId).toBe("local");
    appAtomRegistry.set(atom, AsyncResult.success(result(3, [])));
    expect(readThreadPreviewState(ref).activeTabId).toBeNull();
  });

  it("refreshes a completed cache without treating its old absence as authoritative", async () => {
    using sync = setup();
    const { ref, listAtom, result } = sync;
    const atom = listAtom();
    appAtomRegistry.set(atom, AsyncResult.success(result(1, [])));
    reconcilePreviewServerSessions(ref, result(1, []));
    applyPreviewServerSnapshot(ref, result(1, ["local"]).sessions[0]!);
    applyPreviewDesktopState(ref, "local", {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1.5,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "human",
      favicon: null,
    });
    await using _screen = await sync.mount();
    expect(harness.lists.get(ref.threadId)?.box.requests).toBe(1);
    expect(readThreadPreviewState(ref).activeTabId).toBe("local");
    expect(readThreadPreviewState(ref).desktopOverlay?.zoomFactor).toBe(1.5);
    appAtomRegistry.set(atom, AsyncResult.success(result(2, ["local"])));
    expect(readThreadPreviewState(ref).activeTabId).toBe("local");
    expect(readThreadPreviewState(ref).desktopOverlay?.canGoBack).toBe(true);
  });

  it("retains newer event state when an older list response completes, then retries the list", async () => {
    using sync = setup();
    const { ref, listAtom, result } = sync;
    const atom = listAtom();
    await using _screen = await sync.mount();
    const snapshot = result(2, ["opened"]).sessions[0]!;
    previewEnvironment.events({ environmentId: ref.environmentId, input: {} });
    appAtomRegistry.set(
      harness.events.get(ref.environmentId)!,
      AsyncResult.success({
        type: "opened",
        threadId: ref.threadId,
        tabId: snapshot.tabId,
        snapshot,
        serverEpoch: "epoch-1",
        revision: 2,
        createdAt: snapshot.updatedAt,
      }),
    );
    await act(async () => appAtomRegistry.set(atom, AsyncResult.success(result(1, []))));
    expect(readThreadPreviewState(ref).activeTabId).toBe("opened");
    expect(readThreadPreviewState(ref).serverRevision).toBe(2);
    expect(readThreadPreviewState(ref).listLoaded).toBe(false);
    // The overtaken list is not a baseline, so the hook asks again; its
    // waiting state must not reconcile, and the fresh answer completes it.
    expect(harness.lists.get(ref.threadId)?.box.requests).toBe(2);
    expect(readThreadPreviewState(ref).activeTabId).toBe("opened");
    appAtomRegistry.set(atom, AsyncResult.success(result(2, ["opened"])));
    expect(readThreadPreviewState(ref).listLoaded).toBe(true);
    expect(readThreadPreviewState(ref).activeTabId).toBe("opened");
  });

  it("keeps the local snapshot on a completed failure and reconciles a later success", async () => {
    using sync = setup();
    const { ref, listAtom, result } = sync;
    const atom = listAtom();
    applyPreviewServerSnapshot(ref, result(1, ["local"]).sessions[0]!);
    await using _screen = await sync.mount();
    appAtomRegistry.set(atom, AsyncResult.failure(Cause.die("offline")));
    expect(readThreadPreviewState(ref).activeTabId).toBe("local");
    appAtomRegistry.set(atom, AsyncResult.success(result(2, [])));
    expect(readThreadPreviewState(ref).activeTabId).toBeNull();
  });
});
