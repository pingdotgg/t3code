import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type {
  OrchestrationShellSnapshot,
  OrchestrationThreadAutoReviewPhase,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

import * as AutoReviewJobStore from "./AutoReviewJobStore.ts";
import {
  makeDrainPendingFixes,
  makeQueueOrDispatchFix,
  makeSyncThreadPhases,
} from "./AutoReviewRuntime.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

const NOW = "2026-05-25T12:00:00.000Z";

const makeThread = (overrides: Record<string, unknown> = {}): OrchestrationThreadShell =>
  ({
    id: "thread-1",
    projectId: "proj",
    title: "Thread",
    session: null,
    latestTurn: null,
    latestUserMessageAt: null,
    archivedAt: null,
    updatedAt: NOW,
    autoReviewPhase: null,
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

const makeShell = (threads: ReadonlyArray<OrchestrationThreadShell>): OrchestrationShellSnapshot =>
  ({
    snapshotSequence: 1,
    projects: [],
    threads,
    updatedAt: NOW,
  }) as unknown as OrchestrationShellSnapshot;

const withStore = <A, E>(effect: Effect.Effect<A, E, AutoReviewJobStore.AutoReviewJobStore>) =>
  effect.pipe(Effect.provide(AutoReviewJobStore.layerInMemory), Effect.runPromise);

const enqueueSucceededWithFix = (
  store: AutoReviewJobStore.AutoReviewJobStore["Service"],
  input: { readonly headSha: string; readonly threadId?: string | null },
) =>
  Effect.gen(function* () {
    const { job } = yield* store.enqueue({
      projectId: "proj",
      prNumber: 1,
      headSha: input.headSha,
      trigger: "open_or_push",
      modelSelection,
    });
    const updated = yield* store.update(job.id, {
      status: "succeeded",
      actionableFindings: true,
      originThreadId: (input.threadId === undefined ? "thread-1" : input.threadId) as never,
      pendingFix: {
        threadId: ThreadId.make("thread-1"),
        prompt: `fix ${input.headSha}`,
        queuedAt: NOW as never,
      },
    });
    return updated ?? job;
  });

describe("makeQueueOrDispatchFix", () => {
  it("stores pendingFix instead of dispatching when the thread is busy", async () => {
    const dispatched: Array<{ threadId: string; prompt: string }> = [];
    await withStore(
      Effect.gen(function* () {
        const store = yield* AutoReviewJobStore.AutoReviewJobStore;
        const { job } = yield* store.enqueue({
          projectId: "proj",
          prNumber: 1,
          headSha: "abc",
          trigger: "open_or_push",
          modelSelection,
        });
        const queueOrDispatchFix = makeQueueOrDispatchFix({
          shell: makeShell([makeThread({ session: { status: "running" } })]),
          store,
          dispatchFix: (threadId, prompt) =>
            Effect.sync(() => {
              dispatched.push({ threadId, prompt });
              return true;
            }),
        });

        const outcome = yield* queueOrDispatchFix({
          jobId: job.id,
          threadId: "thread-1",
          prompt: "fix it",
        });

        expect(outcome).toBe("queued");
        expect(dispatched).toHaveLength(0);
        const stored = yield* store.get(job.id);
        expect(stored?.pendingFix?.prompt).toBe("fix it");
        expect(String(stored?.pendingFix?.threadId)).toBe("thread-1");
      }),
    );
  });

  it("dispatches immediately when the thread is idle", async () => {
    const dispatched: Array<{ threadId: string; prompt: string }> = [];
    await withStore(
      Effect.gen(function* () {
        const store = yield* AutoReviewJobStore.AutoReviewJobStore;
        const { job } = yield* store.enqueue({
          projectId: "proj",
          prNumber: 1,
          headSha: "abc",
          trigger: "open_or_push",
          modelSelection,
        });
        const queueOrDispatchFix = makeQueueOrDispatchFix({
          shell: makeShell([makeThread({ session: { status: "idle" } })]),
          store,
          dispatchFix: (threadId, prompt) =>
            Effect.sync(() => {
              dispatched.push({ threadId, prompt });
              return true;
            }),
        });

        const outcome = yield* queueOrDispatchFix({
          jobId: job.id,
          threadId: "thread-1",
          prompt: "fix it",
        });

        expect(outcome).toBe("dispatched");
        expect(dispatched).toEqual([{ threadId: "thread-1", prompt: "fix it" }]);
        const stored = yield* store.get(job.id);
        expect(stored?.pendingFix).toBeNull();
      }),
    );
  });

  it("parks the fix when the dispatch fails", async () => {
    await withStore(
      Effect.gen(function* () {
        const store = yield* AutoReviewJobStore.AutoReviewJobStore;
        const { job } = yield* store.enqueue({
          projectId: "proj",
          prNumber: 1,
          headSha: "abc",
          trigger: "open_or_push",
          modelSelection,
        });
        const queueOrDispatchFix = makeQueueOrDispatchFix({
          shell: makeShell([makeThread({ session: { status: "idle" } })]),
          store,
          dispatchFix: () => Effect.succeed(false),
        });

        const outcome = yield* queueOrDispatchFix({
          jobId: job.id,
          threadId: "thread-1",
          prompt: "fix it",
        });

        expect(outcome).toBe("queued");
        const stored = yield* store.get(job.id);
        expect(stored?.pendingFix?.prompt).toBe("fix it");
      }),
    );
  });
});

describe("makeDrainPendingFixes", () => {
  it("dispatches a pending fix once the thread is idle", async () => {
    const dispatched: Array<{ threadId: string; prompt: string }> = [];
    await withStore(
      Effect.gen(function* () {
        const store = yield* AutoReviewJobStore.AutoReviewJobStore;
        const job = yield* enqueueSucceededWithFix(store, { headSha: "abc" });
        const drain = makeDrainPendingFixes({
          getShell: Effect.succeed(makeShell([makeThread({ session: { status: "idle" } })])),
          store,
          dispatchFix: (threadId, prompt) =>
            Effect.sync(() => {
              dispatched.push({ threadId, prompt });
              return true;
            }),
        });

        yield* drain;

        expect(dispatched).toEqual([{ threadId: "thread-1", prompt: "fix abc" }]);
        const stored = yield* store.get(job.id);
        expect(stored?.pendingFix).toBeNull();
        expect(stored?.autoFixEnqueued).toBe(true);
      }),
    );
  });

  it("keeps the pending fix while the thread is still busy", async () => {
    const dispatched: Array<{ threadId: string; prompt: string }> = [];
    await withStore(
      Effect.gen(function* () {
        const store = yield* AutoReviewJobStore.AutoReviewJobStore;
        const job = yield* enqueueSucceededWithFix(store, { headSha: "abc" });
        const drain = makeDrainPendingFixes({
          getShell: Effect.succeed(makeShell([makeThread({ session: { status: "running" } })])),
          store,
          dispatchFix: (threadId, prompt) =>
            Effect.sync(() => {
              dispatched.push({ threadId, prompt });
              return true;
            }),
        });

        yield* drain;

        expect(dispatched).toHaveLength(0);
        const stored = yield* store.get(job.id);
        expect(stored?.pendingFix?.prompt).toBe("fix abc");
      }),
    );
  });

  it("drops a pending fix superseded by a newer head sha", async () => {
    const dispatched: Array<{ threadId: string; prompt: string }> = [];
    await withStore(
      Effect.gen(function* () {
        const store = yield* AutoReviewJobStore.AutoReviewJobStore;
        const oldJob = yield* enqueueSucceededWithFix(store, { headSha: "abc" });
        yield* enqueueSucceededWithFix(store, { headSha: "def" });
        const drain = makeDrainPendingFixes({
          getShell: Effect.succeed(makeShell([makeThread({ session: { status: "idle" } })])),
          store,
          dispatchFix: (threadId, prompt) =>
            Effect.sync(() => {
              dispatched.push({ threadId, prompt });
              return true;
            }),
        });

        yield* drain;

        // The superseded fix is dropped; the current head's fix still drains.
        expect(dispatched).toEqual([{ threadId: "thread-1", prompt: "fix def" }]);
        const stored = yield* store.get(oldJob.id);
        expect(stored?.pendingFix).toBeNull();
        expect(stored?.autoFixEnqueued).toBe(false);
      }),
    );
  });

  it("drops a pending fix when the thread was archived", async () => {
    const dispatched: Array<{ threadId: string; prompt: string }> = [];
    await withStore(
      Effect.gen(function* () {
        const store = yield* AutoReviewJobStore.AutoReviewJobStore;
        const job = yield* enqueueSucceededWithFix(store, { headSha: "abc" });
        const drain = makeDrainPendingFixes({
          getShell: Effect.succeed(
            makeShell([makeThread({ archivedAt: "2026-05-25T11:00:00.000Z" })]),
          ),
          store,
          dispatchFix: (threadId, prompt) =>
            Effect.sync(() => {
              dispatched.push({ threadId, prompt });
              return true;
            }),
        });

        yield* drain;

        expect(dispatched).toHaveLength(0);
        const stored = yield* store.get(job.id);
        expect(stored?.pendingFix).toBeNull();
        expect(stored?.autoFixEnqueued).toBe(false);
      }),
    );
  });

  it("drops a pending fix when the thread no longer exists", async () => {
    const dispatched: Array<{ threadId: string; prompt: string }> = [];
    await withStore(
      Effect.gen(function* () {
        const store = yield* AutoReviewJobStore.AutoReviewJobStore;
        const job = yield* enqueueSucceededWithFix(store, { headSha: "abc" });
        const drain = makeDrainPendingFixes({
          getShell: Effect.succeed(makeShell([])),
          store,
          dispatchFix: (threadId, prompt) =>
            Effect.sync(() => {
              dispatched.push({ threadId, prompt });
              return true;
            }),
        });

        yield* drain;

        expect(dispatched).toHaveLength(0);
        const stored = yield* store.get(job.id);
        expect(stored?.pendingFix).toBeNull();
      }),
    );
  });
});

describe("makeSyncThreadPhases", () => {
  it("resets a stale shell phase to null when no jobs remain", async () => {
    const phases: Array<{ threadId: string; phase: OrchestrationThreadAutoReviewPhase | null }> =
      [];
    await withStore(
      Effect.gen(function* () {
        const store = yield* AutoReviewJobStore.AutoReviewJobStore;
        const sync = makeSyncThreadPhases({
          getShell: Effect.succeed(makeShell([makeThread({ autoReviewPhase: "reviewing" })])),
          store,
          setPhase: (threadId, phase) =>
            Effect.sync(() => {
              phases.push({ threadId, phase });
            }),
        });

        yield* sync;

        expect(phases).toEqual([{ threadId: "thread-1", phase: null }]);
      }),
    );
  });

  it("sets reviewing while a linked job is queued and does not re-set an equal phase", async () => {
    const phases: Array<{ threadId: string; phase: OrchestrationThreadAutoReviewPhase | null }> =
      [];
    await withStore(
      Effect.gen(function* () {
        const store = yield* AutoReviewJobStore.AutoReviewJobStore;
        const { job } = yield* store.enqueue({
          projectId: "proj",
          prNumber: 1,
          headSha: "abc",
          trigger: "open_or_push",
          modelSelection,
        });
        yield* store.update(job.id, { originThreadId: "thread-1" as never });

        const sync = makeSyncThreadPhases({
          getShell: Effect.succeed(makeShell([makeThread(), makeThread({ id: "thread-2" })])),
          store,
          setPhase: (threadId, phase) =>
            Effect.sync(() => {
              phases.push({ threadId, phase });
            }),
        });

        yield* sync;

        // thread-1 gains "reviewing"; thread-2 already matches and is skipped.
        expect(phases).toEqual([{ threadId: "thread-1", phase: "reviewing" }]);
      }),
    );
  });
});
