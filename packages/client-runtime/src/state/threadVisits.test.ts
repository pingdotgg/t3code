import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import type { VisitThreadInput } from "../operations/commands.ts";
import type { AtomCommandResult } from "./runtime.ts";
import { claimThreadOpen } from "./threadSearch.ts";
import { createThreadVisitTracker, VISIT_DISPATCH_THROTTLE_MS } from "./threadVisits.ts";

const environmentId = EnvironmentId.make("env-visits");

interface Shell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly updatedAt: string;
  readonly lastVisitedAt?: string | null;
  readonly latestRun: { readonly completedAt: string | null } | null;
  readonly wokeAt?: string | null;
}

function at(seconds: number) {
  return `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
}

// claimThreadOpen dedupes per thread in module state, so each test opens its own thread.
function setup(threadName: string, initial: Omit<Shell, "environmentId" | "id"> | null) {
  vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) });
  const threadId = ThreadId.make(threadName);
  const ref = { environmentId, threadId };
  const shellAtom = Atom.make<Shell | null>(
    initial === null ? null : { environmentId, id: threadId, ...initial },
  );
  // Visits the server accepted; offline ones fail without reaching it.
  const visits: Array<VisitThreadInput> = [];
  const localVisits: Array<string> = [];
  let online = true;
  let pendingResult: Promise<AtomCommandResult<void, string>> | undefined;
  const attempts: Array<VisitThreadInput> = [];
  const sessionGenerationAtom = Atom.make(1);
  const tracker = createThreadVisitTracker({
    threadShellAtom: () => shellAtom,
    sessionGenerationAtom: () => sessionGenerationAtom,
    visit: {
      label: "test-visit",
      run: async (_registry, value) => {
        attempts.push(value.input);
        const pending = pendingResult;
        pendingResult = undefined;
        if (online) visits.push(value.input);
        if (pending) return pending;
        if (!online) return AsyncResult.failure(Cause.fail("disconnected"));
        return AsyncResult.success(undefined);
      },
    },
    markLocalVisit: (_ref, visitedAt) => localVisits.push(visitedAt),
  });
  const registry = AtomRegistry.make();
  return {
    ref,
    visits,
    localVisits,
    attempts,
    deferNextVisit: () => {
      const deferred = Promise.withResolvers<AtomCommandResult<void, string>>();
      pendingResult = deferred.promise;
      return () => deferred.resolve(AsyncResult.failure(Cause.fail("disconnected")));
    },
    reconnect: () => registry.set(sessionGenerationAtom, registry.get(sessionGenerationAtom) + 1),
    mount: () => registry.mount(tracker(ref)),
    setOnline: (value: boolean) => {
      online = value;
    },
    update: (patch: Partial<Shell>) => {
      const current = registry.get(shellAtom);
      registry.set(shellAtom, {
        environmentId,
        id: threadId,
        updatedAt: at(0),
        latestRun: null,
        ...current,
        ...patch,
      });
    },
    [Symbol.dispose]: () => vi.useRealTimers(),
  };
}

it("records the open once, then throttles streaming visits", () => {
  using t = setup("thread-throttle", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  t.mount();
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10), opened: true }]);

  vi.advanceTimersByTime(1_000);
  t.update({ updatedAt: at(11) });
  t.update({ updatedAt: at(12) });
  expect(t.visits).toHaveLength(1);

  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS - 1_000);
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(12) }]);
});

it("sends an unseen completion without waiting for the throttle", () => {
  using t = setup("thread-completion", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  t.mount();
  t.update({ updatedAt: at(20), latestRun: { completedAt: at(20) } });
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(20) }]);
});

it("does not resend the open a palette pick already sent", () => {
  using t = setup("thread-palette", { updatedAt: at(10), lastVisitedAt: at(0), latestRun: null });
  claimThreadOpen(environmentId, t.ref.threadId, Date.UTC(2026, 0, 1));
  t.mount();
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10) }]);
});

it("keeps a mark-unread on the open thread until new activity lands", () => {
  using t = setup("thread-unread", { updatedAt: at(10), lastVisitedAt: at(0), latestRun: null });
  t.mount();
  t.update({ lastVisitedAt: at(10) });
  t.update({ lastVisitedAt: at(5) });
  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toHaveLength(1);

  t.update({ updatedAt: at(30) });
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(30) }]);
});

it("keeps a mark-unread on a read thread reopened within the open dedupe window", () => {
  using t = setup("thread-unread-reopened", {
    updatedAt: at(10),
    lastVisitedAt: at(10),
    latestRun: { completedAt: at(9) },
  });
  claimThreadOpen(environmentId, t.ref.threadId, Date.UTC(2026, 0, 1));
  t.mount();
  t.update({ lastVisitedAt: at(8) });
  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toEqual([]);

  // An authoritative snapshot can briefly replace the row with an older one.
  t.update({ updatedAt: at(5), lastVisitedAt: at(5), latestRun: { completedAt: at(4) } });
  t.update({ updatedAt: at(10), lastVisitedAt: at(8), latestRun: { completedAt: at(9) } });
  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toEqual([]);
});

it("keeps mark unread sticky after an expired wake is retired", () => {
  using t = setup("thread-unread-retired-wake", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: { completedAt: at(9) },
    wokeAt: at(15),
  });
  t.mount();
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(15), opened: true }]);
  t.update({ lastVisitedAt: at(15) });
  t.update({ lastVisitedAt: at(8), wokeAt: null });
  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toHaveLength(1);

  t.update({ updatedAt: at(30) });
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(30) }]);
});

it("waits for the shell and records local visits for servers without tracking", () => {
  using t = setup("thread-local", null);
  t.mount();
  expect(t.visits).toEqual([]);
  t.update({ updatedAt: at(10), latestRun: null });
  t.update({ updatedAt: at(11) });
  expect(t.visits).toEqual([]);
  expect(t.localVisits).toEqual([at(10), at(11)]);
});

it("drops a pending visit when the thread is no longer viewed", () => {
  using t = setup("thread-unmount", { updatedAt: at(10), lastVisitedAt: at(0), latestRun: null });
  const unmount = t.mount();
  t.update({ updatedAt: at(11) });
  unmount();
  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toHaveLength(1);
});

it("sends the open with the first visit when the shell arrives after the thread is shown", () => {
  using t = setup("thread-shell-missing", null);
  t.mount();
  expect(claimThreadOpen(environmentId, t.ref.threadId, Date.UTC(2026, 0, 1))).toBe(false);
  expect(t.visits).toEqual([]);

  t.update({ updatedAt: at(10), lastVisitedAt: at(0), latestRun: null });
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10), opened: true }]);

  t.update({ updatedAt: at(10), lastVisitedAt: at(10) });
  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toHaveLength(1);
});

it("advances the watermark to a wake without waiting for the throttle", () => {
  using t = setup("thread-wake", { updatedAt: at(10), lastVisitedAt: at(0), latestRun: null });
  t.mount();
  t.update({ wokeAt: at(15) });
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(15) }]);

  vi.advanceTimersByTime(1_000);
  t.update({ updatedAt: at(16) });
  expect(t.visits).toHaveLength(2);
});

it("retries a failed visit when the same shell returns after reconnect", async () => {
  using t = setup("thread-retry-failed", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  t.setOnline(false);
  t.mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.visits).toEqual([]);

  t.setOnline(true);
  t.reconnect();
  await vi.advanceTimersByTimeAsync(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10), opened: true }]);
});

it("does not retry a failed visit the server already shows as seen", async () => {
  using t = setup("thread-failed-seen", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  t.setOnline(false);
  t.mount();
  t.update({ lastVisitedAt: at(10) });
  await vi.advanceTimersByTimeAsync(0);

  t.setOnline(true);
  t.reconnect();
  t.update({ lastVisitedAt: at(0) });
  await vi.advanceTimersByTimeAsync(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toEqual([]);
});

it("preserves mark unread when an accepted visit fails after the rewind", async () => {
  using t = setup("thread-accepted-rewound-failure", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  const fail = t.deferNextVisit();
  t.mount();
  t.update({ lastVisitedAt: at(10) });
  t.update({ lastVisitedAt: at(5) });
  fail();
  await vi.advanceTimersByTimeAsync(0);
  t.reconnect();
  t.update({});
  await vi.advanceTimersByTimeAsync(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.attempts).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10), opened: true }]);
});

it.each(["unchanged shell", "new shell snapshot"] as const)(
  "retries with %s when reconnect arrives before the pending visit fails",
  async (snapshot) => {
    using t = setup(`thread-reconnect-before-failure-${snapshot}`, {
      updatedAt: at(10),
      lastVisitedAt: at(0),
      latestRun: null,
    });
    t.setOnline(false);
    const fail = t.deferNextVisit();
    t.mount();
    t.setOnline(true);
    t.reconnect();
    if (snapshot === "new shell snapshot") t.update({});
    fail();
    await vi.advanceTimersByTimeAsync(VISIT_DISPATCH_THROTTLE_MS);
    expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10), opened: true }]);
  },
);

it("retries rejected opens only once per connection generation", async () => {
  using t = setup("thread-rejection-throttle", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  t.setOnline(false);
  t.mount();
  await vi.advanceTimersByTimeAsync(0);
  for (let second = 1; second < 10; second++) {
    await vi.advanceTimersByTimeAsync(1_000);
    t.update({});
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(t.attempts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(t.attempts).toHaveLength(1);
  t.reconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.attempts).toHaveLength(2);
  t.update({ updatedAt: at(20), latestRun: { completedAt: at(20) } });
  await vi.advanceTimersByTimeAsync(3 * VISIT_DISPATCH_THROTTLE_MS);
  expect(t.attempts).toHaveLength(2);
});
