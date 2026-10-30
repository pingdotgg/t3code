import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetShellSnapshotError,
  ProjectId,
  ThreadId,
  type OrchestrationV2OlderSettledThreadsPage,
  type OrchestrationV2SearchThreadsResult,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "./shell.ts";
import {
  createOlderSettledThreadAtoms,
  isListedSettledThread,
  olderSettledCountKey,
  settledShelfFrontier,
  unloadedOlderSettledCount,
  wantedOlderSettledPages,
  type OlderSettled,
  type OlderSettledPages,
} from "./olderSettledThreads.ts";

const DAY = 24 * 60 * 60 * 1000;
const environmentId = EnvironmentId.make("env-a");
const project = ProjectId.make("project-a");
const before = DateTime.formatIso(DateTime.makeUnsafe(50 * DAY));
const older: OlderSettled = {
  before,
  beforeMs: 50 * DAY,
  counts: new Map([[project, 3]]),
};

const row = (
  id: string,
  input: {
    readonly settledDay?: number;
    readonly createdDay?: number;
    readonly subagent?: boolean;
  },
) =>
  ({
    id: ThreadId.make(id),
    projectId: project,
    lineage: {
      parentThreadId: input.subagent === true ? ThreadId.make("parent") : null,
      relationshipToParent: input.subagent === true ? "subagent" : null,
      rootThreadId: ThreadId.make(id),
    },
    settledOverride: input.settledDay === undefined ? null : "settled",
    settledAt: input.settledDay === undefined ? null : DateTime.makeUnsafe(input.settledDay * DAY),
    createdAt: DateTime.makeUnsafe((input.createdDay ?? 1) * DAY),
  }) as unknown as OrchestrationV2ThreadShell;

describe("olderSettledCountKey", () => {
  const key = (
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
    removedAt: ReadonlyMap<ThreadId, number> = new Map(),
  ) => olderSettledCountKey(threads, older.beforeMs, removedAt);
  const base = [row("kept-old", { settledDay: 10 }), row("open", { createdDay: 60 })];

  it("changes on every event that can change the older count", () => {
    const start = key(base);
    // A removal, even of an id removed before (the map keeps its size).
    expect(key(base, new Map([[ThreadId.make("x"), 4]]))).not.toBe(start);
    expect(key(base, new Map([[ThreadId.make("x"), 9]]))).not.toBe(
      key(base, new Map([[ThreadId.make("x"), 4]])),
    );
    // An omitted thread that arrives unsettled.
    expect(key([...base, row("woken", { createdDay: 5 })])).not.toBe(start);
    // A local row that turns older (a backdated auto-settle).
    expect(key([base[0]!, row("open", { createdDay: 60, settledDay: 20 })])).not.toBe(start);
  });

  it("stays put for new threads and subagents", () => {
    const start = key(base);
    expect(key([...base, row("new", { createdDay: 70 })])).toBe(start);
    expect(key([...base, row("new-settled", { createdDay: 70, settledDay: 71 })])).toBe(start);
    expect(key([...base, row("child", { createdDay: 5, subagent: true })])).toBe(start);
  });
});

describe("settled shelf listing", () => {
  const pages = (frontier: OlderSettledPages["frontier"]): OlderSettledPages => ({
    reads: [],
    frontier,
    status: "ready",
  });
  const at = (day: number) => DateTime.formatIso(DateTime.makeUnsafe(day * DAY));

  it("lists rows at or above the highest frontier still loading", () => {
    // No page yet: the cut is the frontier, so only rows newer than it list.
    const one = settledShelfFrontier([{ older, pages: pages({ settledAt: before }) }]);
    expect(isListedSettledThread(row("recent", { settledDay: 60 }), one)).toBe(true);
    expect(isListedSettledThread(row("old", { settledDay: 30 }), one)).toBe(false);
    // A row that became older inside the loaded range lists at its place.
    const loaded = settledShelfFrontier([{ older, pages: pages({ settledAt: at(20) }) }]);
    expect(isListedSettledThread(row("old", { settledDay: 30 }), loaded)).toBe(true);
    expect(isListedSettledThread(row("older", { settledDay: 10 }), loaded)).toBe(false);
    // All loaded, or a shell that keeps every settled thread: everything lists.
    expect(settledShelfFrontier([{ older, pages: pages(null) }])).toBeNull();
    expect(settledShelfFrontier([{ older: null, pages: pages(null) }])).toBeNull();
  });

  it("holds back another environment's rows below an environment still loading", () => {
    const frontier = settledShelfFrontier([
      { older, pages: pages({ settledAt: at(40) }) },
      { older, pages: pages({ settledAt: at(20) }) },
    ]);
    expect(frontier).toEqual({ settledAt: at(40) });
    expect(isListedSettledThread(row("b-loaded", { settledDay: 30 }), frontier)).toBe(false);
    // A failed environment holds no one back.
    expect(
      settledShelfFrontier([
        { older, pages: { ...pages({ settledAt: at(40) }), status: "failed" } },
        { older, pages: pages({ settledAt: at(20) }) },
      ]),
    ).toEqual({ settledAt: at(20) });
  });

  it("on a settle-time tie, stops at the cursor that admits fewest rows", () => {
    const strict = pages({ settledAt: at(30) });
    const afterM = pages({ settledAt: at(30), threadId: ThreadId.make("m") });
    const afterK = pages({ settledAt: at(30), threadId: ThreadId.make("k") });
    const frontier = (...all: ReadonlyArray<OlderSettledPages>) =>
      settledShelfFrontier(all.map((each) => ({ older, pages: each })));
    expect(frontier(strict, afterM)).toEqual(afterM.frontier);
    expect(frontier(afterM, strict)).toEqual(afterM.frontier);
    expect(frontier(afterM, afterK)).toEqual(afterK.frontier);
  });

  it("follows the server's id order on a settle-time tie", () => {
    const frontier = { settledAt: at(30), threadId: ThreadId.make("m") };
    expect(isListedSettledThread(row("a", { settledDay: 30 }), frontier)).toBe(true);
    expect(isListedSettledThread(row("z", { settledDay: 30 }), frontier)).toBe(false);
  });
});

it("counts older threads the client does not hold, once", () => {
  const local = [
    // Kept by the snapshot (snoozed) and loaded by a page: the server counts both.
    { source: row("snoozed-old", { settledDay: 10 }), environmentId },
    { source: row("paged-old", { settledDay: 20 }), environmentId },
    { source: row("recent", { settledDay: 60 }), environmentId },
  ];
  const olderSettled = () => older;
  expect(
    unloadedOlderSettledCount({
      olderSettled,
      scopes: [{ environmentId, projectIds: null }],
      threads: local,
    }),
  ).toBe(1);
  expect(
    unloadedOlderSettledCount({
      olderSettled,
      scopes: [{ environmentId, projectIds: [ProjectId.make("other")] }],
      threads: local,
    }),
  ).toBe(0);
  expect(unloadedOlderSettledCount({ olderSettled, scopes: [], threads: local })).toBe(0);
  // Two projects in one environment: each subtracts only its own loaded rows.
  const other = ProjectId.make("project-b");
  const twoProjects = (): OlderSettled => ({
    ...older,
    counts: new Map([
      [project, 10],
      [other, 10],
    ]),
  });
  expect(
    unloadedOlderSettledCount({
      olderSettled: twoProjects,
      scopes: [{ environmentId, projectIds: [project, other] }],
      threads: [
        { source: row("a-old", { settledDay: 10 }), environmentId },
        { source: { ...row("b-old", { settledDay: 10 }), projectId: other }, environmentId },
      ],
    }),
  ).toBe(18);
});

describe("wantedOlderSettledPages", () => {
  const otherEnvironment = EnvironmentId.make("env-b");
  const full = (settledAt: string): OlderSettledPages => ({
    reads: [],
    frontier: { settledAt, threadId: ThreadId.make("t") },
    status: "ready",
  });
  const wanted = (input: {
    readonly requested?: ReadonlyMap<EnvironmentId, number>;
    readonly environments: ReadonlyMap<EnvironmentId, { readonly pages: OlderSettledPages }>;
    readonly listed: number;
    readonly visible: number;
  }) =>
    wantedOlderSettledPages({
      requested: input.requested ?? new Map(),
      environments: new Map(
        [...input.environments].map(([id, { pages }]) => [id, { older, pages }] as const),
      ),
      listedCount: input.listed,
      visibleCount: input.visible,
    });

  it("reads the next page of the environment holding the shelf back", () => {
    const environments = new Map([
      [environmentId, { pages: full("2026-01-10T00:00:00.000Z") }],
      [otherEnvironment, { pages: full("2026-01-20T00:00:00.000Z") }],
    ]);
    expect(wanted({ environments, listed: 9, visible: 10 })).toEqual(
      new Map([[otherEnvironment, 1]]),
    );
    // A deleted row drops the listed count again.
    expect(
      wanted({ requested: new Map([[environmentId, 1]]), environments, listed: 34, visible: 35 }),
    ).toEqual(
      new Map([
        [environmentId, 1],
        [otherEnvironment, 1],
      ]),
    );
  });

  it("waits for pending pages and stops at a short page or a closed shelf", () => {
    const one = (pages: OlderSettledPages) => new Map([[environmentId, { pages }]]);
    const pending = { ...full(before), status: "pending" as const };
    const requested = new Map([[environmentId, 1]]);
    expect(wanted({ requested, environments: one(pending), listed: 0, visible: 10 })).toBe(
      requested,
    );
    const done = { ...full(before), frontier: null };
    expect(wanted({ requested, environments: one(done), listed: 3, visible: 10 })).toBe(requested);
    expect(wanted({ requested, environments: one(full(before)), listed: 10, visible: 10 })).toBe(
      requested,
    );
    expect(wanted({ requested, environments: one(full(before)), listed: 0, visible: 0 })).toBe(
      requested,
    );
  });
});

const TARGET = new PrimaryConnectionTarget({
  environmentId,
  label: "Older settled environment",
  httpBaseUrl: "https://older.example.test",
  wsBaseUrl: "wss://older.example.test",
});

// The atoms over a fake connected environment whose `getOlderSettledThreads` and `searchThreads`
// take their replies, in order, from `replies`.
const makeAtoms = Effect.fn(function* () {
  const replies =
    yield* Queue.unbounded<
      Effect.Effect<
        OrchestrationV2OlderSettledThreadsPage | OrchestrationV2SearchThreadsResult,
        OrchestrationV2GetShellSnapshotError
      >
    >();
  const requests: unknown[] = [];
  // Each request, with a signal for when its read is stopped.
  const requestLog = yield* Queue.unbounded<{
    readonly input: unknown;
    readonly stopped: Deferred.Deferred<void>;
  }>();
  const reply = (input: unknown) =>
    Effect.gen(function* () {
      requests.push(input);
      const stopped = yield* Deferred.make<void>();
      yield* Queue.offer(requestLog, { input, stopped });
      return yield* Effect.flatten(Queue.take(replies)).pipe(
        Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
      );
    });
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads]: reply,
    [ORCHESTRATION_V2_WS_METHODS.searchThreads]: reply,
  } as unknown as WsRpcProtocolClient;
  const session = {
    client,
    initialConfig: Effect.succeed({} as never),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  } as unknown as RpcSession.RpcSession;
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        EnvironmentRegistry.EnvironmentRegistry.of({
          run,
          followStream,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      ),
      // The test's clock, so the count re-read's wait moves with `TestClock.adjust`.
      Layer.succeed(Clock.Clock, yield* Clock.Clock),
    ),
  );
  const shellState = Atom.make<AsyncResult.AsyncResult<EnvironmentShellState>>(
    AsyncResult.success(EMPTY_SHELL_STATE),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return {
    replies,
    requests,
    requestLog,
    atoms: createOlderSettledThreadAtoms(runtime, () => shellState),
    registry,
    setShell: (state: Partial<EnvironmentShellState>) =>
      registry.set(shellState, AsyncResult.success({ ...EMPTY_SHELL_STATE, ...state })),
    // The first value that passes, from a subscription.
    until: <A>(atom: Atom.Atom<A>, done: (value: A) => boolean) =>
      AtomRegistry.toStream(registry, atom).pipe(
        Stream.filter(done),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      ),
  };
});

const shellSnapshot = (input: {
  readonly sequence: number;
  readonly asOfSequence: number;
  readonly count: number;
}) =>
  Option.some({
    schemaVersion: 1,
    snapshotSequence: input.sequence,
    projects: [],
    threads: [row("recent", { settledDay: 60 })],
    archivedThreads: [],
    olderSettled: {
      before,
      asOfSequence: input.asOfSequence,
      counts: [{ projectId: project, count: input.count }],
    },
  } as unknown as OrchestrationV2ShellSnapshot);

describe("createOlderSettledThreadAtoms", () => {
  it.effect("keeps counts current: the snapshot's own, then one read after changes settle", () =>
    Effect.gen(function* () {
      const { replies, requests, atoms, registry, setShell, until } = yield* makeAtoms();
      const olderAtom = atoms.olderSettledAtom(environmentId);
      const count = (value: OlderSettled | null) => value?.counts.get(project);
      registry.mount(olderAtom);

      // A cached shell: its counts stand, read nothing.
      setShell({ snapshot: shellSnapshot({ sequence: 5, asOfSequence: 3, count: 5 }) });
      expect(count(registry.get(olderAtom))).toBe(5);
      // This session's snapshot: its counts are current until something changes.
      setShell({
        snapshot: shellSnapshot({ sequence: 3, asOfSequence: 3, count: 5 }),
        generation: 1,
      });
      expect(count(registry.get(olderAtom))).toBe(5);

      // A removal can change the count: one read once changes stop for a moment.
      yield* Queue.offer(
        replies,
        Effect.succeed({
          snapshotSequence: 4,
          threads: [],
          counts: [{ projectId: project, count: 4 }],
        }),
      );
      setShell({
        snapshot: shellSnapshot({ sequence: 4, asOfSequence: 3, count: 5 }),
        generation: 1,
        removedAt: new Map([[ThreadId.make("gone"), 4]]),
      });
      expect(count(registry.get(olderAtom))).toBe(5);
      yield* TestClock.adjust("500 millis");
      expect(count(yield* until(olderAtom, (value) => count(value) === 4))).toBe(4);
      expect(requests).toEqual([{ before: { settledAt: before }, limit: 0 }]);

      // A new snapshot brings its own counts and drops the read.
      setShell({
        snapshot: shellSnapshot({ sequence: 9, asOfSequence: 9, count: 7 }),
        generation: 2,
      });
      expect(count(registry.get(olderAtom))).toBe(7);
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect("reads pages in order until a short one, and retries a failed page", () =>
    Effect.gen(function* () {
      const { replies, requests, atoms, registry, setShell, until } = yield* makeAtoms();
      const scope = { environmentId, projectIds: null };
      const snapshot = shellSnapshot({ sequence: 3, asOfSequence: 3, count: 30 });

      // A cached shell holds no other environment back: nothing can load yet.
      setShell({ snapshot });
      expect(registry.get(atoms.pagesAtom(scope, 1))).toEqual({
        reads: [],
        frontier: null,
        status: "ready",
      });

      setShell({ snapshot, generation: 1 });
      expect(registry.get(atoms.pagesAtom(scope, 0)).frontier).toEqual({ settledAt: before });
      const full = Array.from({ length: 25 }, (_, index) =>
        row(`full-${String(index).padStart(2, "0")}`, { settledDay: 40 - index }),
      );
      yield* Queue.offer(
        replies,
        Effect.succeed({ snapshotSequence: 3, threads: full, counts: [] }),
      );
      yield* Queue.offer(
        replies,
        Effect.succeed({
          snapshotSequence: 3,
          threads: [row("short", { settledDay: 10 })],
          counts: [],
        }),
      );
      const twoPages = atoms.pagesAtom(scope, 2);
      registry.mount(twoPages);
      const done = yield* until(twoPages, (pages) => pages.reads.length === 2);
      expect(done.frontier).toBeNull();
      expect(done.status).toBe("ready");
      // The second page continues from the first page's last row.
      expect(requests).toEqual([
        { before: { settledAt: before }, limit: 25 },
        {
          before: { settledAt: DateTime.formatIso(full[24]!.settledAt!), threadId: full[24]!.id },
          limit: 25,
        },
      ]);

      // A new snapshot reads again; a failed page shows until a retry reads it.
      const onePage = atoms.pagesAtom(scope, 1);
      registry.mount(onePage);
      setShell({ snapshot, generation: 2 });
      expect(registry.get(onePage).status).toBe("pending");
      yield* Queue.offer(
        replies,
        Effect.fail(new OrchestrationV2GetShellSnapshotError({ message: "read failed" })),
      );
      expect((yield* until(onePage, (pages) => pages.status === "failed")).frontier).toEqual({
        settledAt: before,
      });
      atoms.retryPages(registry, scope, 1);
      expect(registry.get(onePage).status).toBe("pending");
      yield* Queue.offer(
        replies,
        Effect.succeed({ snapshotSequence: 3, threads: full.slice(0, 3), counts: [] }),
      );
      const retried = yield* until(onePage, (pages) => pages.status === "ready");
      expect(retried.reads).toHaveLength(1);
      expect(retried.frontier).toBeNull();
    }),
  );

  it.effect("searches read once per generation, and nothing before the first snapshot", () =>
    Effect.gen(function* () {
      const { replies, requests, atoms, registry, setShell, until } = yield* makeAtoms();
      const snapshot = shellSnapshot({ sequence: 3, asOfSequence: 3, count: 30 });
      const input = { query: "old", olderSettledBefore: before, titlesOnly: true };
      const search = atoms.searchAtom(environmentId, input);

      // That snapshot would drop the rows: loading while it is on its way, idle while offline.
      setShell({ snapshot, status: "synchronizing" });
      registry.mount(search);
      expect(registry.get(search).waiting).toBe(true);
      setShell({ snapshot, status: "cached" });
      expect(registry.get(search).waiting).toBe(false);

      const found = { matches: [], snapshotSequence: 3, threads: [row("old", { settledDay: 9 })] };
      setShell({ snapshot, status: "live", generation: 1 });
      yield* Queue.offer(replies, Effect.succeed(found));
      yield* until(search, AsyncResult.isSuccess);
      // A new snapshot reads the rows again.
      setShell({ snapshot, status: "live", generation: 2 });
      yield* Queue.offer(replies, Effect.succeed({ ...found, snapshotSequence: 8 }));
      yield* until(
        search,
        (result) => AsyncResult.getOrElse(result, () => null)?.snapshotSequence === 8,
      );
      expect(requests).toEqual([input, input]);
    }),
  );

  it.effect("growing reads only the next page, and collapsing stops the shelf's reads", () =>
    Effect.gen(function* () {
      const { replies, requestLog, atoms, registry, setShell, until } = yield* makeAtoms();
      setShell({
        snapshot: shellSnapshot({ sequence: 3, asOfSequence: 3, count: 30 }),
        generation: 1,
      });
      const scope = { environmentId, projectIds: null };
      const full = Array.from({ length: 25 }, (_, index) =>
        row(`full-${String(index).padStart(2, "0")}`, { settledDay: 40 - index }),
      );
      const releaseOne = registry.mount(atoms.pagesAtom(scope, 1));
      expect((yield* Queue.take(requestLog)).input).toEqual({
        before: { settledAt: before },
        limit: 25,
      });
      yield* Queue.offer(
        replies,
        Effect.succeed({ snapshotSequence: 3, threads: full, counts: [] }),
      );
      yield* until(atoms.pagesAtom(scope, 1), (pages) => pages.reads.length === 1);

      // React builds the next shelf before the last one lets go, so page 1 is not read again.
      registry.get(atoms.pagesAtom(scope, 2));
      releaseOne();
      const releaseTwo = registry.mount(atoms.pagesAtom(scope, 2));
      const second = yield* Queue.take(requestLog);
      expect(second.input).toEqual({
        before: { settledAt: DateTime.formatIso(full[24]!.settledAt!), threadId: full[24]!.id },
        limit: 25,
      });

      // Collapsing stops the pending read: nothing is left to run again on a reconnect.
      releaseTwo();
      yield* Deferred.await(second.stopped);
    }),
  );
});
