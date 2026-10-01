import type { PreviewListResult, ScopedThreadRef } from "@t3tools/contracts";
import {
  BROWSER_SESSIONS,
  BROWSER_SURFACE,
  type BrowserSurfaceLease,
} from "@t3tools/extension-sdk/catalogue";
import { Cause } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createBrowserSurfaceBridge,
  type BrowserSurfaceBridgeDeps,
} from "~/extensions/browserSurfaceBridge";
import { readThreadPreviewState } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { mountPreviewSessionSync } from "./usePreviewSession";

// The preview transport is the only substituted seam: the sync atom, the
// preview state store and the surface bridge all run their real code. List
// atoms are writable so the test can replay the exact AsyncResult sequence a
// real query emits — a `waiting` copy of the previous Success while the
// request is in flight, then the completed response.
type ListAtom = Atom.Writable<
  AsyncResult.AsyncResult<PreviewListResult, never>,
  AsyncResult.AsyncResult<PreviewListResult, never>
>;

const previewHarness = vi.hoisted(() => ({
  lists: new Map<
    string,
    {
      box: { current: AsyncResult.AsyncResult<PreviewListResult, never>; requests: number };
      atom: ListAtom;
    }
  >(),
}));

vi.mock("~/state/preview", async () => {
  const effectReactivity = await import("effect/unstable/reactivity");
  const list = (target: { environmentId: string; input: { threadId: string } }) => {
    const threadId = target.input.threadId;
    let entry = previewHarness.lists.get(threadId);
    if (entry === undefined) {
      const box = {
        current: effectReactivity.AsyncResult.initial<PreviewListResult, never>(
          true,
        ) as AsyncResult.AsyncResult<PreviewListResult, never>,
        requests: 0,
      };
      const atom = effectReactivity.Atom.writable(
        () => {
          box.requests += 1;
          return effectReactivity.AsyncResult.waiting(box.current);
        },
        (
          ctx: { setSelf: (value: AsyncResult.AsyncResult<PreviewListResult, never>) => void },
          value: AsyncResult.AsyncResult<PreviewListResult, never>,
        ) => {
          box.current = value;
          ctx.setSelf(value);
        },
      );
      entry = { box, atom };
      previewHarness.lists.set(threadId, entry);
    }
    return entry.atom;
  };
  const events = () => effectReactivity.Atom.make(effectReactivity.AsyncResult.initial());
  return { previewEnvironment: { list, events } };
});

const { previewEnvironment } = await import("~/state/preview");

const threadRef = {
  environmentId: "env-sync",
  threadId: "thread-sync",
} as unknown as ScopedThreadRef;

const listAtom = (ref = threadRef): ListAtom =>
  previewEnvironment.list({
    environmentId: "env-sync",
    input: { threadId: ref.threadId },
  } as never) as ListAtom;

const listResult = (
  revision: number,
  tabIds: string[],
  serverEpoch = "epoch-1",
): PreviewListResult => ({
  serverEpoch,
  revision,
  sessions: tabIds.map(
    (tabId) =>
      ({
        threadId: "thread-sync",
        tabId,
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-09-16T00:00:00.000Z",
      }) as PreviewListResult["sessions"][number],
  ),
});

function bridgeHost(overrides: Partial<BrowserSurfaceBridgeDeps> = {}, ref = threadRef) {
  const lifetime = new AbortController();
  const bind = createBrowserSurfaceBridge("env-sync", {
    composites: () => true,
    schedule: (flush) => {
      flush();
      return () => {};
    },
    acquireNative: () => ({
      present: () => true,
      release: () => {},
    }),
    ownerOf: () => null,
    subscribeStore: () => () => {},
    resolveThreadScope: () => ({ projectId: "project-a", authoritative: true }),
    subscribeThread: () => () => {},
    // mountSessionSync / readSessions / subscribeSessions / refreshSessions
    // stay at production defaults: the real sync atom + real store.
    ...overrides,
  });
  const host = bind({
    grants: {
      capabilities: [BROWSER_SESSIONS, BROWSER_SURFACE],
      projectIds: ["project-a"],
    },
    lifetime: lifetime.signal,
  });
  const acquire = () =>
    host.acquire({
      context: {
        client: "web",
        resource: {
          namespace: "test.plugin",
          id: "view",
          environmentId: "env-sync",
          projectId: "project-a",
          threadId: ref.threadId,
        },
      },
      session: { tabId: "tab-new", serverEpoch: "epoch-1" },
    });
  return { acquire, lifetime };
}

describe("previewSessionSync arbitration", () => {
  it.each([4_000, 8_000])(
    "waits for the real sync's late refresh (%s ms) without retrying",
    async (delay) => {
      vi.useFakeTimers();
      const ref = { ...threadRef, threadId: `thread-late-${delay}` } as ScopedThreadRef;
      const atom = listAtom(ref);
      appAtomRegistry.set(atom, AsyncResult.success(listResult(1, [], "epoch-old")));
      const { acquire, lifetime } = bridgeHost({}, ref);
      let settled = false;
      const pending = Promise.resolve(acquire()).then((result) => {
        settled = true;
        return result;
      });
      try {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(settled).toBe(false);
        expect(previewHarness.lists.get(ref.threadId)?.box.requests).toBe(1);
        appAtomRegistry.set(atom, AsyncResult.success(listResult(2, ["tab-new"])));
        await vi.advanceTimersByTimeAsync(1);
        const acquired = await pending;
        expect(acquired.ok).toBe(true);
        if (!acquired.ok) throw new Error("expected the refreshed session to attach");
        expect(acquired.lease.state.kind).toBe("active");
        expect(previewHarness.lists.get(ref.threadId)?.box.requests).toBe(1);
        acquired.lease.release();
      } finally {
        lifetime.abort();
        vi.useRealTimers();
      }
    },
  );

  it("returns epoch-changed only after the refresh still reports a different epoch", async () => {
    const ref = { ...threadRef, threadId: "thread-stale" } as ScopedThreadRef;
    const atom = listAtom(ref);
    appAtomRegistry.set(atom, AsyncResult.success(listResult(1, [], "epoch-old")));
    const { acquire } = bridgeHost({}, ref);
    const pending = Promise.resolve(acquire());
    await Promise.resolve();
    appAtomRegistry.set(atom, AsyncResult.success(listResult(2, [], "epoch-new")));
    const acquired = await pending;
    expect(acquired.ok).toBe(false);
    if (acquired.ok) throw new Error("expected a stale session denial");
    expect(acquired.denial.reason).toBe("epoch-changed");
    expect(previewHarness.lists.get(ref.threadId)?.box.requests).toBe(1);
  });

  it.each(["failure", "timeout"])(
    "returns host-unavailable when synchronization ends in %s",
    async (outcome) => {
      vi.useFakeTimers();
      const ref = { ...threadRef, threadId: `thread-offline-${outcome}` } as ScopedThreadRef;
      const atom = listAtom(ref);
      appAtomRegistry.set(atom, AsyncResult.success(listResult(1, [], "epoch-old")));
      const { acquire, lifetime } = bridgeHost({}, ref);
      const pending = Promise.resolve(acquire());
      try {
        await Promise.resolve();
        if (outcome === "failure")
          appAtomRegistry.set(atom, AsyncResult.failure(Cause.die("offline")));
        else await vi.advanceTimersByTimeAsync(30_000);
        const acquired = await pending;
        expect(acquired.ok).toBe(false);
        if (acquired.ok) throw new Error("expected an unavailable host");
        expect(acquired.denial.reason).toBe("host-unavailable");
        expect(previewHarness.lists.get(ref.threadId)?.box.requests).toBe(1);
      } finally {
        lifetime.abort();
        vi.useRealTimers();
      }
    },
  );

  it("uses exactly one list request on a cold attach", async () => {
    const ref = { ...threadRef, threadId: "thread-cold" } as ScopedThreadRef;
    const atom = listAtom(ref);
    const { acquire } = bridgeHost({}, ref);
    const pending = Promise.resolve(acquire());
    await Promise.resolve();
    expect(previewHarness.lists.get(ref.threadId)?.box.requests).toBe(1);
    appAtomRegistry.set(atom, AsyncResult.success(listResult(1, ["tab-new"])));
    const acquired = await pending;
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error("expected the cold session to attach");
    await Promise.resolve();
    expect(previewHarness.lists.get(ref.threadId)?.box.requests).toBe(1);
    acquired.lease.release();
  });

  it("uses zero list requests when attaching to a warm matching sync", async () => {
    const ref = { ...threadRef, threadId: "thread-warm" } as ScopedThreadRef;
    const atom = listAtom(ref);
    const unmount = mountPreviewSessionSync(ref);
    const { acquire, lifetime } = bridgeHost({}, ref);
    try {
      await Promise.resolve();
      appAtomRegistry.set(atom, AsyncResult.success(listResult(1, ["tab-new"])));
      const baselineRequests = previewHarness.lists.get(ref.threadId)?.box.requests;
      expect(baselineRequests).toBe(1);
      for (const attempt of [1, 2]) {
        const acquired = await acquire();
        if (!acquired.ok) throw new Error(`expected warm attach ${attempt} to succeed`);
        try {
          await Promise.resolve();
          expect(acquired.lease.state.kind).toBe("active");
          expect(previewHarness.lists.get(ref.threadId)?.box.requests).toBe(baselineRequests);
        } finally {
          acquired.lease.release();
        }
      }
    } finally {
      lifetime.abort();
      unmount();
    }
  });

  it("refreshes a reused sync after a failure without waiting for its idle TTL", async () => {
    const ref = { ...threadRef, threadId: "thread-reused" } as ScopedThreadRef;
    const atom = listAtom(ref);
    appAtomRegistry.set(atom, AsyncResult.success(listResult(1, [], "epoch-old")));
    const { acquire } = bridgeHost({}, ref);
    const first = acquire();
    await Promise.resolve();
    appAtomRegistry.set(atom, AsyncResult.failure(Cause.die("offline")));
    expect((await first).ok).toBe(false);
    const second = acquire();
    await Promise.resolve();
    expect(previewHarness.lists.get(ref.threadId)?.box.requests).toBe(2);
    appAtomRegistry.set(atom, AsyncResult.success(listResult(2, ["tab-new"])));
    const acquired = await second;
    if (!acquired.ok) throw new Error("expected the reused sync to recover");
    acquired.lease.release();
  });

  it("does not treat a refresh's waiting replay as a completed list", async () => {
    // Warm-synced state: a completed authoritative list already applied and
    // the requested tab is absent from it.
    appAtomRegistry.set(listAtom(), AsyncResult.success(listResult(1, []), { timestamp: 1 }));
    const { acquire } = bridgeHost();
    const acquired = await acquire();
    if (!acquired.ok) throw new Error("expected lease");
    const lease: BrowserSurfaceLease = acquired.lease;
    const baseline = readThreadPreviewState(threadRef).listSeq;
    expect(baseline).toBe(1);
    expect(lease.state.kind).toBe("active");
    await Promise.resolve();

    // The bridge's forced refresh replays the previous Success with
    // waiting:true while the request is in flight — replayed data is not
    // authority for absence, so the lease must survive.
    appAtomRegistry.set(
      listAtom(),
      AsyncResult.success(listResult(1, []), { waiting: true, timestamp: 1 }),
    );
    expect(readThreadPreviewState(threadRef).listSeq).toBe(1);
    expect(lease.state.kind).toBe("active");

    // The completed response is the arbitrating answer: absent → closed.
    appAtomRegistry.set(listAtom(), AsyncResult.success(listResult(2, []), { timestamp: 2 }));
    expect(readThreadPreviewState(threadRef).listSeq).toBe(2);
    expect(lease.state).toEqual({ kind: "ended", reason: "session-closed" });
  });

  it("keeps the lease when the arbitrating list contains the tab", async () => {
    appAtomRegistry.set(listAtom(), AsyncResult.success(listResult(3, []), { timestamp: 3 }));
    const { acquire } = bridgeHost();
    const acquired = await acquire();
    if (!acquired.ok) throw new Error("expected lease");
    const lease = acquired.lease;
    await Promise.resolve();

    appAtomRegistry.set(
      listAtom(),
      AsyncResult.success(listResult(3, []), { waiting: true, timestamp: 3 }),
    );
    expect(lease.state.kind).toBe("active");
    appAtomRegistry.set(
      listAtom(),
      AsyncResult.success(listResult(4, ["tab-new"]), { timestamp: 4 }),
    );
    expect(lease.state.kind).toBe("active");
    expect(readThreadPreviewState(threadRef).sessions["tab-new"]).toBeDefined();
    lease.release();
  });

  it("counts a completed Failure as an attempt, retries, and verifies on a later list", async () => {
    appAtomRegistry.set(listAtom(), AsyncResult.success(listResult(5, []), { timestamp: 5 }));
    const { acquire } = bridgeHost();
    const acquired = await acquire();
    if (!acquired.ok) throw new Error("expected lease");
    const lease = acquired.lease;
    const baselineFailures = readThreadPreviewState(threadRef).listFailures;
    const baselineSeq = readThreadPreviewState(threadRef).listSeq;
    await Promise.resolve();

    // The arbitrating request completes with Failure — a completed attempt,
    // not evidence the tab is absent. The lease survives and a retry fires.
    appAtomRegistry.set(
      listAtom(),
      AsyncResult.failure<PreviewListResult, never>(Cause.die("offline")),
    );
    expect(readThreadPreviewState(threadRef).listFailures).toBe(baselineFailures + 1);
    expect(readThreadPreviewState(threadRef).listSeq).toBe(baselineSeq);
    expect(lease.state.kind).toBe("active");

    // A waiting re-emission of the same failure is not another attempt.
    appAtomRegistry.set(
      listAtom(),
      AsyncResult.failure<PreviewListResult, never>(Cause.die("offline"), { waiting: true }),
    );
    expect(readThreadPreviewState(threadRef).listFailures).toBe(baselineFailures + 1);
    expect(lease.state.kind).toBe("active");

    // A later completed list containing the tab verifies the session.
    appAtomRegistry.set(
      listAtom(),
      AsyncResult.success(listResult(7, ["tab-new"]), { timestamp: 7 }),
    );
    expect(lease.state.kind).toBe("active");
    expect(readThreadPreviewState(threadRef).sessions["tab-new"]).toBeDefined();
    lease.release();
  });

  it("ends an unverified lease when no completed list arrives before the deadline", async () => {
    const deferred: (() => void)[] = [];
    appAtomRegistry.set(listAtom(), AsyncResult.success(listResult(8, []), { timestamp: 8 }));
    const { acquire } = bridgeHost({
      defer: (fn) => {
        deferred.push(fn);
        return () => {};
      },
    });
    const acquired = await acquire();
    if (!acquired.ok) throw new Error("expected lease");
    await Promise.resolve();
    // The arbitrating request never resolves — the bound ends the lease.
    for (const fn of deferred) fn();
    expect(acquired.lease.state).toEqual({ kind: "ended", reason: "session-unverified" });
  });
});
