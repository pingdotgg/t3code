import { describe, expect, it } from "@effect/vitest";
import * as NodeV8 from "node:v8";
import * as NodeVM from "node:vm";
import { vi } from "vite-plus/test";
import {
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  EnvironmentId,
  type FilesystemBrowseEntry,
  type IssueListInput,
  type IssueListResult,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ArchivedShellSnapshot,
  ThreadId,
  ProjectId,
  type ReviewDiffPreviewInput,
  type PreviewEvent,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import type { HttpClient } from "effect/http";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import {
  createOrchestrationEnvironmentAtoms,
  PartialThreadLinkMetadataError,
} from "./orchestration.ts";
import { createReviewEnvironmentAtoms } from "./review.ts";
import { createPreviewEnvironmentAtoms } from "./preview.ts";
import { createFilesystemEnvironmentAtoms } from "./filesystem.ts";
import { createIssueEnvironmentAtoms, createMergedIssueListAtoms } from "./issues.ts";
import type { QueryPersistence } from "./queryPersistence.ts";
import type { EnvironmentShellState } from "./shell.ts";
import { v2Now, v2Project, v2ThreadId, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { createTerminalEnvironmentAtoms } from "./terminal.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  selectEnvironmentQueryData,
  createEnvironmentSubscriptionAtomFamily,
  createRuntimeCommand,
  environmentSessionGenerationAtom,
  executeAtomQuery,
  type QueryAnswerHandler,
} from "./runtime.ts";

const QUERY_ENVIRONMENT = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("query-environment"),
  label: "Query environment",
  httpBaseUrl: "https://query.example.test",
  wsBaseUrl: "wss://query.example.test",
});

const decodeNumber = Schema.decodeUnknownEffect(Schema.Number);

const QUERY_RPC_SESSION = {} as RpcSession.RpcSession;

class TestQueryError extends Schema.TaggedError<TestQueryError>()("TestQueryError", {
  message: Schema.String,
}) {}

const isTestQueryError = Schema.is(TestQueryError);
const isPartialThreadLinkMetadataError = Schema.is(PartialThreadLinkMetadataError);

const OFFLINE_QUERY_FAILURE = new ConnectionTransientError({
  reason: "transport",
  detail: "Relay is unavailable.",
});

const BLOCKED_QUERY_FAILURE = new ConnectionBlockedError({
  reason: "permission",
  detail: "Access denied.",
});

function queryConnectionState(
  overrides: Partial<SupervisorConnectionState> = {},
): SupervisorConnectionState {
  return {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
    ...overrides,
  };
}

const makeEnvironmentQueryHarness = Effect.fn("TestEnvironmentQuery.makeHarness")(function* <A, E>(
  execute: Effect.Effect<A, E>,
  {
    refreshTrigger,
    idleTtlMs,
    persistence,
    initialState,
    rpcSession,
    isFinal,
    onAnswer,
  }: {
    readonly refreshTrigger?: Atom.Atom<unknown>;
    readonly onAnswer?: QueryAnswerHandler<undefined, A>;
    readonly isFinal?: (value: A) => boolean;
    readonly idleTtlMs?: number;
    readonly persistence?: QueryPersistence<A>;
    readonly initialState?: SupervisorConnectionState;
    readonly rpcSession?: RpcSession.RpcSession;
  } = {},
) {
  const supervisorState = yield* SubscriptionRef.make(initialState ?? queryConnectionState());
  const supervisorSession = yield* SubscriptionRef.make(
    Option.some(rpcSession ?? QUERY_RPC_SESSION),
  );
  const streamGeneration = yield* SubscriptionRef.make(0);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: QUERY_ENVIRONMENT,
    state: supervisorState,
    session: supervisorSession,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) =>
    SubscriptionRef.changes(streamGeneration).pipe(
      Stream.switchMap(() =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      ),
    );
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
    stateChanges: () => SubscriptionRef.changes(supervisorState),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  );
  const family = createEnvironmentQueryAtomFamily(runtime, {
    label: "test.environment-query",
    staleTimeMs: 60_000,
    ...(persistence === undefined ? {} : { persistence }),
    execute: () => execute,
    ...(refreshTrigger === undefined ? {} : { refreshTrigger: () => refreshTrigger }),
    ...(idleTtlMs === undefined ? {} : { idleTtlMs }),
    ...(isFinal === undefined ? {} : { isFinal }),
    ...(onAnswer === undefined ? {} : { onAnswer }),
  });

  return {
    runtime,
    family,
    atom: family({ environmentId: QUERY_ENVIRONMENT.environmentId, input: undefined }),
    supervisorSession,
    supervisorState,
    streamGeneration,
  };
});

/**
 * `getResult` resumes from inside the query's listener, so it only unsubscribes
 * once the reader yields.
 */
const readEnvironmentQuery = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) =>
  AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }).pipe(
    Effect.tap(() => Effect.yieldNow),
  );

const mountEnvironmentQuery = Effect.fn("TestEnvironmentQuery.mount")(function* <A>(
  atom: Atom.Atom<A>,
) {
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unmount();
      registry.dispose();
    }),
  );
  return registry;
});

it.effect("keeps complete review metadata visible while a refresh is held", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let fullReads = 0;
    const rpcSession = {
      client: {
        [WS_METHODS.reviewGetDiffPreview]: (input: ReviewDiffPreviewInput) =>
          Effect.gen(function* () {
            if (!input.trackedOnly && ++fullReads > 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            return {
              cwd: input.cwd,
              generatedAt: DateTime.makeUnsafe(0),
              ...(input.trackedOnly ? { incomplete: true } : {}),
              sources: [
                {
                  id: "working-tree",
                  kind: "working-tree" as const,
                  title: "Uncommitted",
                  baseRef: "HEAD",
                  headRef: null,
                  diff: "",
                  diffHash: String(fullReads),
                  truncated: false,
                  patchesDeferred: true,
                  files: (input.trackedOnly ? ["tracked"] : ["tracked", "untracked"]).map(
                    (path) => ({ path, previousPath: null, additions: 1, deletions: 0 }),
                  ),
                },
              ],
            };
          }),
      },
    } as unknown as RpcSession.RpcSession;
    const harness = yield* makeEnvironmentQueryHarness(Effect.void, { rpcSession });
    const atom = createReviewEnvironmentAtoms(harness.runtime).diffPreview({
      environmentId: QUERY_ENVIRONMENT.environmentId,
      input: { cwd: "/project", sourceKind: "working-tree", metadataOnly: true },
    });
    const registry = yield* mountEnvironmentQuery(atom);
    expect((yield* readEnvironmentQuery(registry, atom)).sources[0]!.files).toHaveLength(2);
    registry.refresh(atom);
    yield* Deferred.await(started);
    yield* Effect.sync(() => {
      const value = AsyncResult.getOrElse(registry.get(atom), () => null);
      expect(value?.incomplete).not.toBe(true);
      expect(value?.sources[0]!.files).toHaveLength(2);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    expect((yield* readEnvironmentQuery(registry, atom)).sources[0]!.diffHash).toBe("2");
  }),
);

it.effect("does not re-read a file patch read while its preview was revalidating", () =>
  Effect.gen(function* () {
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    const previewStarted = yield* Deferred.make<void>();
    const releasePreview = yield* Deferred.make<void>();
    let previewReads = 0;
    let patchReads = 0;
    const rpcSession = {
      client: {
        [WS_METHODS.reviewGetDiffPreview]: (input: ReviewDiffPreviewInput) =>
          Effect.gen(function* () {
            if (input.file) patchReads += 1;
            else if (++previewReads > 1) {
              yield* Deferred.succeed(previewStarted, undefined);
              yield* Deferred.await(releasePreview);
            }
            return {
              cwd: input.cwd,
              generatedAt: DateTime.makeUnsafe(previewReads),
              sources: [
                {
                  id: "working-tree",
                  kind: "working-tree" as const,
                  title: "Uncommitted",
                  baseRef: "HEAD",
                  headRef: null,
                  diff: "",
                  diffHash: "same",
                  truncated: false,
                  patchesDeferred: true,
                  files: [{ path: "a.ts", previousPath: null, additions: 1, deletions: 0 }],
                },
              ],
            };
          }),
      },
    } as unknown as RpcSession.RpcSession;
    const harness = yield* makeEnvironmentQueryHarness(Effect.void, { rpcSession });
    const review = createReviewEnvironmentAtoms(harness.runtime);
    const previewInput = {
      cwd: "/project",
      sourceKind: "working-tree",
      metadataOnly: true,
    } as const;
    const preview = review.diffPreview({
      environmentId: QUERY_ENVIRONMENT.environmentId,
      input: previewInput,
    });
    const registry = yield* mountEnvironmentQuery(preview);
    yield* readEnvironmentQuery(registry, preview);

    // Opening the Diff panel revalidates the preview and reads the visible patches at once.
    registry.refresh(preview);
    yield* Deferred.await(previewStarted);
    const patch = review.diffFilePatch({
      environmentId: QUERY_ENVIRONMENT.environmentId,
      input: {
        request: {
          cwd: "/project",
          sourceKind: "working-tree",
          file: { sourceKind: "working-tree", path: "a.ts", previousPath: null },
        },
        cacheKey: "a.ts",
        preview: previewInput,
      },
    });
    registry.mount(patch);
    yield* readEnvironmentQuery(registry, patch);
    expect(patchReads).toBe(1);

    yield* Deferred.succeed(releasePreview, undefined);
    yield* readEnvironmentQuery(registry, preview);
    yield* readEnvironmentQuery(registry, patch);
    expect(patchReads).toBe(1);

    // A revalidation requested after the patch was read still refreshes it.
    now = 1;
    registry.refresh(preview);
    yield* readEnvironmentQuery(registry, preview);
    yield* readEnvironmentQuery(registry, patch);
    expect(patchReads).toBe(2);
  }),
);

it.effect("keeps manual Issues refresh intent through an overlapping write", () =>
  Effect.gen(function* () {
    const requests = yield* Queue.unbounded<IssueListInput>();
    const release = yield* Deferred.make<void>();
    const answer: IssueListResult = {
      viewers: {},
      trackers: [],
      entries: [],
      errors: [],
      nextCursors: {},
    };
    const rpcSession = {
      client: {
        [WS_METHODS.issuesList]: (input: IssueListInput) =>
          Queue.offer(requests, input).pipe(
            Effect.andThen(input.refresh ? Deferred.await(release) : Effect.void),
            Effect.as(answer),
          ),
      },
    } as unknown as RpcSession.RpcSession;
    const { runtime } = yield* makeEnvironmentQueryHarness(Effect.void, { rpcSession });
    const issues = createIssueEnvironmentAtoms(runtime);
    const listings = createMergedIssueListAtoms(issues, String);
    const target = {
      environmentId: QUERY_ENVIRONMENT.environmentId,
      input: { state: "all" },
    } as const;
    const registry = yield* mountEnvironmentQuery(listings.atom([target]));
    expect(yield* Queue.take(requests)).toEqual({ state: "all" });
    yield* readEnvironmentQuery(registry, issues.list(target));

    listings.refresh(registry, [target], "manual");
    expect(yield* Queue.take(requests)).toEqual({ state: "all", refresh: true });

    listings.refreshEnvironment(registry, target.environmentId);
    expect(yield* Queue.take(requests)).toEqual({ state: "all", refresh: true });

    yield* Deferred.succeed(release, undefined);
    yield* readEnvironmentQuery(registry, issues.list(target));
    listings.refreshEnvironment(registry, target.environmentId);
    expect(yield* Queue.take(requests)).toEqual({ state: "all" });
  }),
);

describe("preview event subscriptions", () => {
  it.effect("delivers every open and close when RPC events arrive in batches", () =>
    Effect.gen(function* () {
      const opened: PreviewEvent[] = ["thread-a", "thread-b"].map((threadId, index) => ({
        type: "opened",
        threadId,
        tabId: `tab-${index}`,
        serverEpoch: "epoch-1",
        revision: index + 1,
        createdAt: "2026-10-02T00:00:00.000Z",
        snapshot: {
          threadId,
          tabId: `tab-${index}`,
          navStatus: { _tag: "Idle" },
          canGoBack: false,
          canGoForward: false,
          updatedAt: "2026-10-02T00:00:00.000Z",
        },
      }));
      const closed: PreviewEvent[] = opened.map((event, index) => ({
        type: "closed",
        threadId: event.threadId,
        tabId: event.tabId,
        serverEpoch: event.serverEpoch,
        revision: opened.length + index + 1,
        createdAt: event.createdAt,
      }));
      const releaseEvents = yield* Deferred.make<void>();
      // Each iterable is one RPC chunk; separate emissions would hide lost events.
      const stream = Stream.fromEffect(Deferred.await(releaseEvents)).pipe(
        Stream.flatMap(() =>
          Stream.fromIterable(opened).pipe(
            Stream.concat(Stream.fromIterable(closed)),
            Stream.concat(Stream.never),
          ),
        ),
      );
      const harness = yield* makeEnvironmentQueryHarness(Effect.void, {
        rpcSession: {
          client: { [WS_METHODS.subscribePreviewEvents]: () => stream },
        } as unknown as RpcSession.RpcSession,
      });
      const atom = createPreviewEnvironmentAtoms(harness.runtime).events({
        environmentId: QUERY_ENVIRONMENT.environmentId,
        input: {},
      });
      const registry = AtomRegistry.make();
      const observed: PreviewEvent[] = [];
      const sawLast = yield* Deferred.make<void>();
      const unsubscribe = registry.subscribe(
        atom,
        (result) => {
          if (!AsyncResult.isSuccess(result)) return;
          observed.push(result.value);
          if (result.value === closed[closed.length - 1]) {
            Deferred.doneUnsafe(sawLast, Exit.void);
          }
        },
        { immediate: true },
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe();
          registry.dispose();
        }),
      );

      yield* Deferred.succeed(releaseEvents, undefined);
      yield* Deferred.await(sawLast);
      expect(observed).toEqual([...opened, ...closed]);
    }),
  );
});

describe("finite environment subscription lifecycle", () => {
  it.effect(
    "exposes early values and settles on the terminal value without waiting for a reconnect",
    () =>
      Effect.gen(function* () {
        const releaseFinal = yield* Deferred.make<void>();
        const sawEarly = yield* Deferred.make<void>();
        const sawFinal = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const stream = Stream.concat(
          Stream.succeed({ complete: false, count: 1 }),
          Stream.fromEffect(
            Deferred.await(releaseFinal).pipe(Effect.as({ complete: true, count: 123 })),
          ),
        ).pipe(Stream.ensuring(Deferred.succeed(closed, undefined)));
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          followStream: (_environmentId: EnvironmentId, source: typeof stream) =>
            Stream.concat(source, Stream.never),
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        );
        const family = createEnvironmentSubscriptionAtomFamily(runtime, {
          label: "test.finite-subscription",
          subscribe: () => stream,
          completeWhen: (value) => value.complete,
          idleTtlMs: 0,
        });
        const atom = family({ environmentId: QUERY_ENVIRONMENT.environmentId, input: undefined });
        const registry = AtomRegistry.make();
        const observed: Array<
          AsyncResult.AsyncResult<{ complete: boolean; count: number }, unknown>
        > = [];
        const unsubscribe = registry.subscribe(
          atom,
          (result) => {
            observed.push(result);
            if (AsyncResult.isSuccess(result)) {
              if (!result.value.complete) Deferred.doneUnsafe(sawEarly, Exit.void);
              if (result.value.complete && !result.waiting)
                Deferred.doneUnsafe(sawFinal, Exit.void);
            }
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe();
            registry.dispose();
          }),
        );
        yield* Deferred.await(sawEarly);
        const early = registry.get(atom);
        expect(AsyncResult.isSuccess(early) && early.value.count).toBe(1);
        expect(early.waiting).toBe(true);
        yield* Deferred.succeed(releaseFinal, undefined);
        yield* Deferred.await(sawFinal);
        yield* Deferred.await(closed);
        const final = registry.get(atom);
        expect(AsyncResult.isSuccess(final) && final.value.count).toBe(123);
        expect(final.waiting).toBe(false);
        expect(observed.some((result) => AsyncResult.isFailure(result))).toBe(false);
      }),
  );
  it.effect(
    "surfaces a decode defect from a finite RPC subscription instead of resubscribing",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstSubscribed = yield* Deferred.make<void>();
          const resubscribed = yield* Deferred.make<void>();
          const surfaced = yield* Deferred.make<Cause.Cause<unknown>>();
          let subscriptions = 0;
          // Mirrors RpcClient, which decodes each chunk with `Effect.orDie`.
          const decodeDefect = decodeNumber("not a number").pipe(Effect.orDie);
          const client = {
            [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: () => {
              subscriptions += 1;
              Deferred.doneUnsafe(subscriptions === 1 ? firstSubscribed : resubscribed, Exit.void);
              return Stream.fromEffect(decodeDefect).pipe(Stream.drain);
            },
          } as unknown as WsRpcProtocolClient;
          const rpcSession = {
            client,
            initialConfig: Effect.never,
            subscribeServerConfig: () => Stream.never,
            ready: Effect.void,
            probe: Effect.void,
            closed: Effect.never,
          } as unknown as RpcSession.RpcSession;
          const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
            target: QUERY_ENVIRONMENT,
            state: yield* SubscriptionRef.make(queryConnectionState()),
            session: yield* SubscriptionRef.make(Option.some(rpcSession)),
            prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
          const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
            followStream: (_environmentId: EnvironmentId, stream: Stream.Stream<unknown>) =>
              Stream.provideService(
                stream,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
          // Atoms run their own fibers; share the test clock so a pending retry is driven by it.
          const runtime = Atom.runtime(
            Layer.mergeAll(
              Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
              Layer.succeed(Clock.Clock, yield* Clock.Clock),
            ),
          );
          // Same options as the progressive thread find in orchestration.ts.
          const family = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
            label: "test.finite-rpc-subscription",
            tag: ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
            completeWhen: (result) => result.complete !== false,
            idleTtlMs: 0,
          });
          const atom = family({
            environmentId: QUERY_ENVIRONMENT.environmentId,
            input: {} as never,
          });
          const registry = AtomRegistry.make();
          const unsubscribe = registry.subscribe(
            atom,
            (result) => {
              if (AsyncResult.isFailure(result))
                Deferred.doneUnsafe(surfaced, Exit.succeed(result.cause));
            },
            { immediate: true },
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              unsubscribe();
              registry.dispose();
            }),
          );
          yield* Deferred.await(firstSubscribed);
          // Lets any same-session retry run, so its resubscription can win the race below.
          yield* TestClock.adjust("1 minute");
          const outcome = yield* Effect.raceFirst(
            Deferred.await(surfaced).pipe(
              Effect.map((cause) => ({ _tag: "surfaced", cause }) as const),
            ),
            Deferred.await(resubscribed).pipe(Effect.as({ _tag: "resubscribed" } as const)),
          );

          expect(
            outcome._tag,
            "finite subscription resubscribed after a decode defect instead of failing its consumer",
          ).toBe("surfaced");
          if (outcome._tag === "surfaced") {
            expect(Cause.hasDies(outcome.cause)).toBe(true);
            expect(Schema.isSchemaError(Cause.squash(outcome.cause))).toBe(true);
          }
          expect(subscriptions).toBe(1);
        }),
      ),
  );
  it.effect.each([
    { completedTtlMs: undefined, subscriptions: 2 },
    { completedTtlMs: 60_000, subscriptions: 1 },
  ])(
    "reopening a completed subscription subscribes $subscriptions time(s) with completedTtlMs $completedTtlMs",
    ({ completedTtlMs, subscriptions }) =>
      Effect.gen(function* () {
        let subscribed = 0;
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          followStream: (_environmentId: EnvironmentId, source: Stream.Stream<unknown>) => source,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        );
        const family = createEnvironmentSubscriptionAtomFamily(runtime, {
          label: "test.completed-subscription",
          subscribe: () =>
            Stream.suspend(() => {
              subscribed += 1;
              return Stream.make({ complete: false }, { complete: true });
            }),
          completeWhen: (value) => value.complete,
          idleTtlMs: 0,
          ...(completedTtlMs === undefined ? {} : { completedTtlMs }),
        });
        const atom = family({ environmentId: QUERY_ENVIRONMENT.environmentId, input: undefined });
        // Flushed after each close: idle removals have run by the time a user reopens a row.
        const scheduled: Array<() => void> = [];
        const registry = AtomRegistry.make({
          scheduleTask: (task) => {
            scheduled.push(task);
            return () => undefined;
          },
        });
        const open = Effect.gen(function* () {
          const settled = yield* Deferred.make<boolean>();
          const unsubscribe = registry.subscribe(
            atom,
            (result) => {
              if (AsyncResult.isSuccess(result) && !result.waiting) {
                Deferred.doneUnsafe(settled, Exit.succeed(result.value.complete));
              }
            },
            { immediate: true },
          );
          const complete = yield* Deferred.await(settled);
          unsubscribe();
          for (const task of scheduled.splice(0)) task();
          return complete;
        });

        expect(yield* open).toBe(true);
        expect(yield* open).toBe(true);
        expect(subscribed).toBe(subscriptions);
        registry.dispose();
      }),
  );
});

describe("environment query lifecycle", () => {
  it.effect(
    "terminal metadata retains known sessions until a new snapshot and keeps the manager identity",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeEnvironmentQueryHarness(Effect.void);
        const started = yield* Queue.unbounded<void>();
        const events = yield* Queue.unbounded<TerminalMetadataStreamEvent>();
        const receivedCheckout = yield* Deferred.make<void>();
        const receivedEmpty = yield* Deferred.make<void>();
        const checkout: TerminalSummary = {
          threadId: "thread-1",
          terminalId: "terminal-1",
          cwd: "/repo/root/packages/app",
          worktreePath: null,
          status: "running",
          pid: 123,
          exitCode: null,
          exitSignal: null,
          hasRunningSubprocess: false,
          label: "Terminal 1",
          updatedAt: "2026-04-01T00:00:00.000Z",
        };
        const client = {
          [WS_METHODS.subscribeTerminalMetadata]: () =>
            Stream.fromEffect(Queue.offer(started, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.fromQueue(events)),
            ),
        } as unknown as RpcSession.RpcSession["client"];
        const session = { ...QUERY_RPC_SESSION, client };
        yield* SubscriptionRef.set(harness.supervisorSession, Option.some(session));
        const atoms = createTerminalEnvironmentAtoms(harness.runtime);
        const target = { environmentId: QUERY_ENVIRONMENT.environmentId, input: null };
        const atom = atoms.metadata(target);
        const feed = atoms.metadataFeed(target);
        const registry = AtomRegistry.make();
        const observed: Array<ReadonlyArray<TerminalSummary>> = [];
        const unsubscribe = registry.subscribe(
          atom,
          (result) => {
            if (!AsyncResult.isSuccess(result)) return;
            observed.push(result.value);
            if (result.value.length > 0) Deferred.doneUnsafe(receivedCheckout, Exit.void);
            else Deferred.doneUnsafe(receivedEmpty, Exit.void);
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe();
            registry.dispose();
          }),
        );

        yield* Queue.take(started);
        expect(selectEnvironmentQueryData(registry.get(atom))).toBeNull();
        expect(observed).toEqual([]);

        yield* Queue.offer(events, {
          type: "snapshot",
          terminals: [checkout],
          managerId: "manager-1",
        });
        yield* Deferred.await(receivedCheckout);
        expect(selectEnvironmentQueryData(registry.get(atom))).toEqual([checkout]);
        const initialSnapshotId = selectEnvironmentQueryData(registry.get(feed))?.snapshotId;
        expect(initialSnapshotId).toBe("manager-1");

        yield* SubscriptionRef.set(harness.supervisorSession, Option.some({ ...session }));
        yield* Queue.take(started);
        expect(selectEnvironmentQueryData(registry.get(atom))).toEqual([checkout]);

        yield* SubscriptionRef.update(harness.streamGeneration, (generation) => generation + 1);
        yield* Queue.take(started);
        expect(selectEnvironmentQueryData(registry.get(atom))).toEqual([checkout]);

        yield* Queue.offer(events, { type: "snapshot", terminals: [], managerId: "manager-1" });
        yield* Deferred.await(receivedEmpty);
        expect(selectEnvironmentQueryData(registry.get(atom))).toEqual([]);
        expect(selectEnvironmentQueryData(registry.get(feed))?.snapshotId).toBe(initialSnapshotId);
      }),
  );

  it.effect("terminal attach resubscribes with resume only after the stream replied", () =>
    Effect.gen(function* () {
      const harness = yield* makeEnvironmentQueryHarness(Effect.void);
      const inputs = yield* Queue.unbounded<TerminalAttachInput>();
      const events = yield* Queue.unbounded<TerminalAttachStreamEvent>();
      const received = yield* Deferred.make<void>();
      const client = {
        [WS_METHODS.terminalAttach]: (input: TerminalAttachInput) =>
          Stream.fromEffect(Queue.offer(inputs, input)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromQueue(events)),
          ),
      } as unknown as RpcSession.RpcSession["client"];
      const firstSession = { ...QUERY_RPC_SESSION, client };
      yield* SubscriptionRef.set(harness.supervisorSession, Option.some(firstSession));
      const input = {
        threadId: "thread-1",
        terminalId: "terminal-1",
        cwd: "/tmp/project",
        restartIfNotRunning: true,
      };
      const sent = { ...input, maxHistoryBytes: DEFAULT_MAX_TERMINAL_BUFFER_BYTES };
      const atoms = createTerminalEnvironmentAtoms(harness.runtime);
      const registry = AtomRegistry.make();
      const atom = atoms.attach({ environmentId: QUERY_ENVIRONMENT.environmentId, input });
      const unmount = registry.subscribe(
        atom,
        (result) => {
          if (AsyncResult.isSuccess(result) && result.value.version > 0) {
            Deferred.doneUnsafe(received, Exit.void);
          }
        },
        { immediate: true },
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unmount();
          registry.dispose();
        }),
      );

      expect(yield* Queue.take(inputs)).toEqual(sent);
      yield* SubscriptionRef.set(harness.supervisorSession, Option.some({ ...firstSession }));
      expect(yield* Queue.take(inputs)).toEqual(sent);
      yield* Queue.offer(events, {
        type: "closed",
        threadId: input.threadId,
        terminalId: input.terminalId,
      });
      yield* Deferred.await(received);

      yield* SubscriptionRef.set(harness.supervisorSession, Option.some({ ...firstSession }));
      expect(yield* Queue.take(inputs)).toEqual({ ...sent, resume: true });
      // Catalog replacements rerun the same stream through followStream's switchMap.
      yield* SubscriptionRef.update(harness.streamGeneration, (generation) => generation + 1);
      expect(yield* Queue.take(inputs)).toEqual({ ...sent, resume: true });

      unmount();
      registry.dispose();
      const remountedRegistry = AtomRegistry.make();
      const remount = remountedRegistry.subscribe(atom, () => {}, { immediate: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          remount();
          remountedRegistry.dispose();
        }),
      );
      expect(yield* Queue.take(inputs)).toEqual(sent);
    }),
  );

  // The server sizes a shared PTY to every attached viewer, so a lingering attach pins its grid.
  it.effect("terminal attach detaches as soon as its last viewer leaves", () =>
    Effect.gen(function* () {
      const harness = yield* makeEnvironmentQueryHarness(Effect.void);
      const attached = yield* Deferred.make<void>();
      const detached = yield* Deferred.make<void>();
      const client = {
        [WS_METHODS.terminalAttach]: () =>
          Stream.fromEffect(Deferred.succeed(attached, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
            Stream.ensuring(Deferred.succeed(detached, undefined)),
          ),
      } as unknown as RpcSession.RpcSession["client"];
      yield* SubscriptionRef.set(
        harness.supervisorSession,
        Option.some({ ...QUERY_RPC_SESSION, client }),
      );
      const atoms = createTerminalEnvironmentAtoms(harness.runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const unsubscribe = registry.subscribe(
        atoms.attach({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadId: "thread-1", terminalId: "terminal-1", cwd: "/tmp/project" },
        }),
        () => {},
        { immediate: true },
      );
      yield* Deferred.await(attached);

      unsubscribe();
      yield* Deferred.await(detached);
    }),
  );

  it.effect(
    "hides a session replacement, reports the relay backoff, and recovers on reconnect",
    () =>
      Effect.gen(function* () {
        const firstStarted = Latch.makeUnsafe();
        const failFirst = Latch.makeUnsafe();
        const firstSettled = Latch.makeUnsafe();
        const unavailable = new EnvironmentRpcUnavailableError({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          message: "Query environment is not connected.",
        });
        let executions = 0;
        const execute = Effect.suspend(() => {
          executions += 1;
          if (executions > 1) {
            return Effect.succeed("recovered");
          }
          firstStarted.openUnsafe();
          return failFirst.await.pipe(
            Effect.andThen(Effect.fail(unavailable)),
            Effect.ensuring(
              Effect.sync(() => {
                firstSettled.openUnsafe();
              }),
            ),
          );
        });
        const harness = yield* makeEnvironmentQueryHarness(execute);
        const registry = AtomRegistry.make();
        const observed: Array<AsyncResult.AsyncResult<string, unknown>> = [];
        const unsubscribe = registry.subscribe(
          harness.atom,
          (result) => {
            observed.push(result);
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe();
            registry.dispose();
          }),
        );

        yield* firstStarted.await;
        yield* SubscriptionRef.set(harness.supervisorSession, Option.none());
        yield* Effect.yieldNow;
        failFirst.openUnsafe();
        yield* firstSettled.await;
        yield* Effect.yieldNow;

        expect(observed.some(AsyncResult.isFailure)).toBe(false);

        yield* SubscriptionRef.set(
          harness.supervisorState,
          queryConnectionState({ phase: "connecting", stage: "preparing" }),
        );
        yield* Effect.yieldNow;
        const relayFailure = new ConnectionTransientError({
          reason: "transport",
          detail: "Relay session is reconnecting.",
        });
        yield* SubscriptionRef.set(
          harness.supervisorState,
          queryConnectionState({
            phase: "backoff",
            stage: null,
            lastFailure: relayFailure,
            retryAt: 1,
          }),
        );
        yield* Effect.yieldNow;
        // The query has never answered, so it reports why the environment is retrying.
        const backingOff = registry.get(harness.atom);
        expect(backingOff.waiting).toBe(false);
        expect(AsyncResult.isFailure(backingOff) && Cause.squash(backingOff.cause)).toBe(
          relayFailure,
        );

        yield* SubscriptionRef.set(harness.supervisorSession, Option.some(QUERY_RPC_SESSION));
        yield* SubscriptionRef.set(
          harness.supervisorState,
          queryConnectionState({ generation: 2 }),
        );
        yield* Effect.yieldNow;
        expect(
          yield* AtomRegistry.getResult(registry, harness.atom, {
            suspendOnWaiting: true,
          }),
        ).toBe("recovered");
      }),
  );

  it.effect("keeps a query pending when it loses its session before the atom sees the change", () =>
    Effect.gen(function* () {
      const firstStarted = Latch.makeUnsafe();
      const failFirst = Latch.makeUnsafe();
      const firstSettled = Latch.makeUnsafe();
      let executions = 0;
      const execute = Effect.suspend(() => {
        executions += 1;
        if (executions > 1) {
          return Effect.succeed("recovered");
        }
        firstStarted.openUnsafe();
        return failFirst.await.pipe(
          Effect.andThen(
            Effect.fail(
              new EnvironmentRpcUnavailableError({
                environmentId: QUERY_ENVIRONMENT.environmentId,
                message: "Query environment is not connected.",
              }),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              firstSettled.openUnsafe();
            }),
          ),
        );
      });
      const harness = yield* makeEnvironmentQueryHarness(execute);
      const registry = AtomRegistry.make();
      const observed: Array<AsyncResult.AsyncResult<string, unknown>> = [];
      const unsubscribe = registry.subscribe(
        harness.atom,
        (result) => {
          observed.push(result);
        },
        { immediate: true },
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe();
          registry.dispose();
        }),
      );

      yield* firstStarted.await;
      // No yield before the failure: the request finds its session gone
      // before the atom has processed the session change.
      yield* SubscriptionRef.set(harness.supervisorSession, Option.none());
      failFirst.openUnsafe();
      yield* firstSettled.await;
      yield* Effect.yieldNow;

      expect(observed.some(AsyncResult.isFailure)).toBe(false);

      yield* SubscriptionRef.set(harness.supervisorSession, Option.some(QUERY_RPC_SESSION));
      yield* SubscriptionRef.set(harness.supervisorState, queryConnectionState({ generation: 2 }));
      expect(
        yield* AtomRegistry.getResult(registry, harness.atom, {
          suspendOnWaiting: true,
        }),
      ).toBe("recovered");
      expect(observed.some(AsyncResult.isFailure)).toBe(false);
    }),
  );

  it.effect("fails a query that reports unavailable while its session is still live", () =>
    Effect.gen(function* () {
      const unavailable = new EnvironmentRpcUnavailableError({
        environmentId: QUERY_ENVIRONMENT.environmentId,
        message: "The environment did not respond to the request.",
      });
      const harness = yield* makeEnvironmentQueryHarness(Effect.fail(unavailable));
      const registry = yield* mountEnvironmentQuery(harness.atom);

      const exit = yield* AtomRegistry.getResult(registry, harness.atom, {
        suspendOnWaiting: true,
      }).pipe(Effect.exit);

      expect(exit).toStrictEqual(Exit.fail(unavailable));
    }),
  );

  it.effect.each([
    {
      condition: "after a manual disconnect",
      state: queryConnectionState({
        desired: false,
        phase: "available",
        stage: null,
        attempt: 0,
      }),
      expectedFailure: null,
    },
    {
      condition: "while the environment is offline",
      state: queryConnectionState({
        network: "offline",
        phase: "offline",
        stage: null,
        lastFailure: OFFLINE_QUERY_FAILURE,
      }),
      expectedFailure: OFFLINE_QUERY_FAILURE,
    },
    {
      condition: "when connection recovery is blocked",
      state: queryConnectionState({
        phase: "blocked",
        stage: null,
        lastFailure: BLOCKED_QUERY_FAILURE,
      }),
      expectedFailure: BLOCKED_QUERY_FAILURE,
    },
  ] as const)("settles as unavailable $condition", ({ state, expectedFailure }) =>
    Effect.gen(function* () {
      const harness = yield* makeEnvironmentQueryHarness(Effect.succeed("connected"));
      const registry = yield* mountEnvironmentQuery(harness.atom);

      expect(
        yield* AtomRegistry.getResult(registry, harness.atom, {
          suspendOnWaiting: true,
        }),
      ).toBe("connected");

      yield* SubscriptionRef.set(harness.supervisorState, state);
      yield* Effect.yieldNow;

      const result = registry.get(harness.atom);
      expect(AsyncResult.isFailure(result)).toBe(true);
      expect(result.waiting).toBe(false);
      if (AsyncResult.isFailure(result) && expectedFailure !== null) {
        expect(Cause.squash(result.cause)).toBe(expectedFailure);
      }
    }),
  );

  it.effect.each([
    { phase: "backoff", stage: null, retryAt: 1 },
    { phase: "connecting", stage: "opening", retryAt: null },
  ] as const)(
    "settles a query it never answered while its environment retries ($phase)",
    (retrying) =>
      Effect.gen(function* () {
        const harness = yield* makeEnvironmentQueryHarness(Effect.succeed("connected"), {
          initialState: queryConnectionState({ ...retrying, lastFailure: OFFLINE_QUERY_FAILURE }),
        });
        const registry = yield* mountEnvironmentQuery(harness.atom);
        yield* Effect.yieldNow;

        const result = registry.get(harness.atom);
        expect(result.waiting).toBe(false);
        expect(AsyncResult.isFailure(result) && Cause.squash(result.cause)).toBe(
          OFFLINE_QUERY_FAILURE,
        );

        yield* SubscriptionRef.set(harness.supervisorState, queryConnectionState());
        yield* Effect.yieldNow;
        expect(yield* readEnvironmentQuery(registry, harness.atom)).toBe("connected");
      }),
  );

  it.effect("a refresh started on a new session generation answers from that session", () =>
    Effect.gen(function* () {
      const harness = yield* makeEnvironmentQueryHarness(Effect.succeed("connected"), {
        initialState: queryConnectionState({
          phase: "backoff",
          stage: null,
          lastFailure: OFFLINE_QUERY_FAILURE,
          retryAt: 1,
        }),
      });
      const registry = yield* mountEnvironmentQuery(harness.atom);
      // Callers hold the failure a read got while the environment was retrying.
      const failed = yield* Effect.promise(() =>
        executeAtomQuery(registry, harness.atom, { reportFailure: false }),
      );
      expect(AsyncResult.isFailure(failed)).toBe(true);

      const answered = yield* Deferred.make<AsyncResult.AsyncResult<string, unknown>>();
      const sessionGeneration = environmentSessionGenerationAtom(
        harness.runtime,
        QUERY_ENVIRONMENT.environmentId,
      );
      const unmount = registry.mount(sessionGeneration);
      const unsubscribe = registry.subscribe(sessionGeneration, () => {
        void executeAtomQuery(registry, harness.atom, {
          refresh: true,
          reportFailure: false,
        }).then((result) => Deferred.doneUnsafe(answered, Effect.succeed(result)));
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe();
          unmount();
        }),
      );
      yield* Effect.yieldNow;

      yield* SubscriptionRef.set(
        harness.supervisorSession,
        Option.some({} as RpcSession.RpcSession),
      );
      yield* SubscriptionRef.set(harness.supervisorState, queryConnectionState({ generation: 2 }));
      expect(yield* Deferred.await(answered)).toMatchObject({
        _tag: "Success",
        value: "connected",
      });
    }),
  );

  it.effect("keeps a genuine query failure settled while reconnecting", () =>
    Effect.gen(function* () {
      const expectedFailure = new TestQueryError({ message: "Query failed." });
      const firstStarted = Latch.makeUnsafe();
      const failFirst = Latch.makeUnsafe();
      const refreshStarted = Latch.makeUnsafe();
      const finishRefresh = Latch.makeUnsafe();
      let executions = 0;
      const execute = Effect.suspend(() => {
        executions += 1;
        if (executions === 1) {
          firstStarted.openUnsafe();
          return failFirst.await.pipe(Effect.andThen(Effect.fail(expectedFailure)));
        }
        refreshStarted.openUnsafe();
        return finishRefresh.await.pipe(Effect.as("recovered"));
      });
      const harness = yield* makeEnvironmentQueryHarness(execute);
      const registry = yield* mountEnvironmentQuery(harness.atom);

      yield* firstStarted.await;
      failFirst.openUnsafe();
      const initial = yield* AtomRegistry.getResult(registry, harness.atom, {
        suspendOnWaiting: true,
      }).pipe(Effect.exit);
      expect(Exit.isFailure(initial)).toBe(true);
      if (Exit.isFailure(initial)) {
        expect(Cause.squash(initial.cause)).toBe(expectedFailure);
      }

      yield* SubscriptionRef.set(
        harness.supervisorState,
        queryConnectionState({ phase: "connecting", stage: "opening" }),
      );
      yield* Effect.yieldNow;

      const refreshing = registry.get(harness.atom);
      expect(AsyncResult.isFailure(refreshing)).toBe(true);
      expect(refreshing.waiting).toBe(true);
      if (AsyncResult.isFailure(refreshing)) {
        expect(Cause.squash(refreshing.cause)).toBe(expectedFailure);
      }

      yield* SubscriptionRef.set(harness.supervisorState, queryConnectionState({ generation: 2 }));
      yield* refreshStarted.await;
      finishRefresh.openUnsafe();
      expect(
        yield* AtomRegistry.getResult(registry, harness.atom, {
          suspendOnWaiting: true,
        }),
      ).toBe("recovered");
    }),
  );

  it.effect("retains the last successful value while reconnecting", () =>
    Effect.gen(function* () {
      const refreshStarted = Latch.makeUnsafe();
      const finishRefresh = Latch.makeUnsafe();
      let executions = 0;
      const execute = Effect.suspend(() => {
        executions += 1;
        if (executions === 1) {
          return Effect.succeed("cached");
        }
        refreshStarted.openUnsafe();
        return finishRefresh.await.pipe(Effect.as("updated"));
      });
      const harness = yield* makeEnvironmentQueryHarness(execute);
      const registry = yield* mountEnvironmentQuery(harness.atom);

      expect(
        yield* AtomRegistry.getResult(registry, harness.atom, {
          suspendOnWaiting: true,
        }),
      ).toBe("cached");

      yield* SubscriptionRef.set(
        harness.supervisorState,
        queryConnectionState({ phase: "connecting", stage: "opening" }),
      );
      yield* Effect.yieldNow;
      expect(registry.get(harness.atom)).toMatchObject({
        _tag: "Success",
        value: "cached",
        waiting: true,
      });

      yield* SubscriptionRef.set(
        harness.supervisorState,
        queryConnectionState({
          phase: "backoff",
          stage: null,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Retrying.",
          }),
          retryAt: 1,
        }),
      );
      yield* Effect.yieldNow;
      expect(registry.get(harness.atom)).toMatchObject({
        _tag: "Success",
        value: "cached",
        waiting: true,
      });

      yield* SubscriptionRef.set(harness.supervisorState, queryConnectionState({ generation: 2 }));
      yield* refreshStarted.await;
      expect(registry.get(harness.atom)).toMatchObject({
        _tag: "Success",
        value: "cached",
        waiting: true,
      });

      finishRefresh.openUnsafe();
      expect(
        yield* AtomRegistry.getResult(registry, harness.atom, {
          suspendOnWaiting: true,
        }),
      ).toBe("updated");
    }),
  );

  it.effect("filesystem browse lists the directory afresh when a picker reopens it", () =>
    Effect.gen(function* () {
      const harness = yield* makeEnvironmentQueryHarness(Effect.void);
      const entry = (name: string): FilesystemBrowseEntry => ({
        name,
        fullPath: `/tmp/t3-11476-repro/${name}`,
      });
      let onDisk = [entry("existing")];
      const client = {
        [WS_METHODS.filesystemBrowse]: () =>
          Effect.sync(() => ({ parentPath: "/tmp/t3-11476-repro/", entries: onDisk })),
      } as unknown as RpcSession.RpcSession["client"];
      yield* SubscriptionRef.set(
        harness.supervisorSession,
        Option.some({ ...QUERY_RPC_SESSION, client }),
      );
      const atom = createFilesystemEnvironmentAtoms(harness.runtime).browse({
        environmentId: QUERY_ENVIRONMENT.environmentId,
        input: { partialPath: "/tmp/t3-11476-repro/" },
      });
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      // Stale-while-revalidate refreshes from a task on the registry scheduler;
      // queue behind it so the read sees the revalidation instead of racing it.
      const afterScheduledTasks = Effect.callback<void>((resume) => {
        registry.schedulerAsync.makeDispatcher().scheduleTask(() => resume(Effect.void), 0);
      });
      const listNames = afterScheduledTasks.pipe(
        Effect.andThen(readEnvironmentQuery(registry, atom)),
        Effect.map((result) => result.entries.map((browseEntry) => browseEntry.name)),
      );

      const closePicker = registry.mount(atom);
      expect(yield* listNames).toEqual(["existing"]);
      closePicker();
      // A closed picker stays closed past the registry's scheduled node
      // removal; a remount within the same tick keeps the live node.
      yield* afterScheduledTasks;

      onDisk = [entry("created-externally"), entry("existing")];
      registry.mount(atom);
      expect(yield* listNames).toEqual(["created-externally", "existing"]);
    }),
  );

  it.effect("refreshes on its trigger while read, and once on its next read when idle", () =>
    Effect.gen(function* () {
      let executions = 0;
      const trigger = Atom.make(0).pipe(Atom.keepAlive);
      const harness = yield* makeEnvironmentQueryHarness(
        Effect.sync(() => (executions += 1)),
        { refreshTrigger: trigger },
      );
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const read = readEnvironmentQuery(registry, harness.atom);

      const unmount = registry.mount(harness.atom);
      expect(yield* read).toBe(1);
      registry.set(trigger, 1);
      expect(yield* read).toBe(2);

      unmount();
      registry.set(trigger, 2);
      registry.set(trigger, 3);
      expect(executions).toBe(2);

      expect(yield* read).toBe(3);
    }),
  );

  it.effect("refetches a stale query on remount while another view keeps the cache live", () =>
    Effect.gen(function* () {
      let now = 0;
      using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
      let contents = "before edit";
      let fetches = 0;
      const harness = yield* makeEnvironmentQueryHarness(
        Effect.sync(() => {
          fetches += 1;
          return contents;
        }),
      );
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const sidebar = harness.family(
        { environmentId: QUERY_ENVIRONMENT.environmentId, input: undefined },
        "sidebar",
      );
      registry.mount(sidebar);
      const read = readEnvironmentQuery(registry, harness.atom);
      const remount = Effect.gen(function* () {
        const unmount = registry.mount(harness.atom);
        yield* Effect.yieldNow;
        const value = yield* read;
        unmount();
        yield* Effect.yieldNow;
        return value;
      });

      expect(yield* remount).toBe("before edit");
      contents = "after edit";

      // Inside the harness's 60s stale time: the cached value stands.
      now = 30_000;
      expect(yield* remount).toBe("before edit");
      expect(fetches).toBe(1);

      // Past the stale time, well inside the default 5 minute idle TTL.
      now = 61_000;
      expect(yield* remount).toBe("after edit");
      expect(yield* readEnvironmentQuery(registry, sidebar)).toBe("after edit");
      expect(fetches).toBe(2);
    }),
  );

  it.effect("keeps its cache when collected while unmounted, inside its stale time", () =>
    Effect.gen(function* () {
      NodeV8.setFlagsFromString("--expose-gc");
      const gc = NodeVM.runInNewContext("gc") as () => void;
      using _now = vi.spyOn(Date, "now").mockReturnValue(0);
      let fetches = 0;
      const harness = yield* makeEnvironmentQueryHarness(
        Effect.sync(() => {
          fetches += 1;
          return fetches;
        }),
      );
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      // `Atom.family` holds members weakly, so the test must hold none: another environment
      // than `harness.atom`'s, which the harness holds.
      const environmentId = EnvironmentId.make("unheld-environment");
      const query = () => harness.family({ environmentId, input: undefined });
      const first = new WeakRef(query());
      const remount = Effect.gen(function* () {
        const unmount = registry.mount(query());
        yield* Effect.yieldNow;
        const value = yield* readEnvironmentQuery(registry, query());
        unmount();
        return value;
      });
      // A WeakRef target survives until the current job ends, so collect after it.
      const collect = Effect.yieldNow.pipe(Effect.andThen(Effect.sync(gc)));

      expect(yield* remount).toBe(1);
      yield* collect;
      expect(yield* remount).toBe(1);
      yield* collect;
      expect(first.deref()).toBe(query());
      expect(fetches).toBe(1);
    }),
  );

  it.effect.each([true, false])("loads thread link metadata with server support %s", (supported) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project");
      const tag = supported
        ? ORCHESTRATION_V2_WS_METHODS.getThreadLinkMetadata
        : ORCHESTRATION_V2_WS_METHODS.getThreadTitles;
      const harness = yield* makeEnvironmentQueryHarness(Effect.void, {
        rpcSession: {
          initialConfig: Effect.succeed({ threadLinkMetadata: supported }),
          client: {
            [tag]: () =>
              Effect.succeed(supported ? { fork: { title: "Fork", projectId } } : { fork: "Fork" }),
          },
        } as unknown as RpcSession.RpcSession,
      });
      const runtime = harness.runtime as unknown as Atom.AtomRuntime<
        EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient
      >;
      const atom = createOrchestrationEnvironmentAtoms(runtime).threadLinkMetadata({
        environmentId: QUERY_ENVIRONMENT.environmentId,
        input: { threadIds: [ThreadId.make("fork")] },
      });
      const registry = yield* mountEnvironmentQuery(atom);
      expect(yield* readEnvironmentQuery(registry, atom)).toEqual({
        fork: { title: "Fork", projectId: supported ? projectId : null },
      });
    }),
  );

  it.effect(
    "coalesces concurrent threadLinkMetadata queries, caches per thread synchronously, and invalidates on shell removal",
    () =>
      Effect.gen(function* () {
        const projectId = ProjectId.make("project");
        const calls: Array<ReadonlyArray<ThreadId>> = [];
        const requests =
          yield* Queue.unbounded<
            Deferred.Deferred<Record<string, { title: string; projectId: ProjectId | null }>>
          >();
        const harness = yield* makeEnvironmentQueryHarness(Effect.void, {
          rpcSession: {
            initialConfig: Effect.succeed({ threadLinkMetadata: true }),
            client: {
              [ORCHESTRATION_V2_WS_METHODS.getThreadLinkMetadata]: (input: {
                readonly threadIds: ReadonlyArray<ThreadId>;
              }) =>
                Effect.gen(function* () {
                  calls.push(input.threadIds);
                  const answer =
                    yield* Deferred.make<
                      Record<string, { title: string; projectId: ProjectId | null }>
                    >();
                  yield* Queue.offer(requests, answer);
                  return yield* Deferred.await(answer);
                }),
            },
          } as unknown as RpcSession.RpcSession,
        });
        const shellState = Atom.make<Pick<EnvironmentShellState, "removedAt" | "generation">>({
          removedAt: new Map(),
          generation: 0,
        }).pipe(Atom.keepAlive);
        const runtime = harness.runtime as unknown as Atom.AtomRuntime<
          EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient
        >;
        const orchestration = createOrchestrationEnvironmentAtoms(runtime, {
          shellState: () => shellState,
        });

        const t1 = ThreadId.make("t1");
        const t2 = ThreadId.make("t2");
        const t3 = ThreadId.make("t3");
        const t4 = ThreadId.make("t4");
        const t5 = ThreadId.make("t5");
        const atomA = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [t1, t2] },
        });
        const atomB = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [t2, t3] },
        });
        const atomC = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [t4] },
        });
        const emptyAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [] },
        });

        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const releaseC = registry.mount(atomC);
        const releaseA = registry.mount(atomA);
        const releaseB = registry.mount(atomB);
        const releaseEmpty = registry.mount(emptyAtom);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releaseA();
            releaseB();
            releaseC();
            releaseEmpty();
          }),
        );

        const firstRequest = yield* Queue.take(requests);

        expect(calls).toHaveLength(1);
        const [firstCall] = calls;
        expect(firstCall).toBeDefined();
        expect([...(firstCall ?? [])].toSorted()).toEqual([t1, t2, t3, t4]);

        yield* Deferred.succeed(firstRequest, {
          [t1]: { title: "One", projectId },
          [t2]: { title: "Two", projectId },
          [t3]: { title: "Three", projectId: null },
        });

        expect(yield* readEnvironmentQuery(registry, atomA)).toEqual({
          [t1]: { title: "One", projectId },
          [t2]: { title: "Two", projectId },
        });
        expect(yield* readEnvironmentQuery(registry, atomB)).toEqual({
          [t2]: { title: "Two", projectId },
          [t3]: { title: "Three", projectId: null },
        });
        const emptyResult = yield* readEnvironmentQuery(registry, emptyAtom);
        expect(emptyResult).toEqual({});
        expect(calls).toHaveLength(1);

        // A cold single-ID or subset query for already-cached threads (including cached misses)
        // settles synchronously with zero new RPCs.
        const singleHit = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [t1] },
        });
        const singleMiss = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [t4] },
        });
        expect(registry.get(singleHit)).toMatchObject({
          _tag: "Success",
          waiting: false,
          value: { [t1]: { title: "One", projectId } },
        });
        expect(registry.get(singleMiss)).toMatchObject({
          _tag: "Success",
          waiting: false,
          value: {},
        });
        expect(calls).toHaveLength(1);

        // A query mixing a cached thread and an uncached thread emits the cached slice immediately
        // and fetches only the uncached thread.
        const mixedAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [t1, t5] },
        });
        const mixedStates: Array<AsyncResult.AsyncResult<unknown, unknown>> = [];
        const unsubMixed = registry.subscribe(
          mixedAtom,
          (value) => {
            mixedStates.push(value);
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubMixed));
        const mixedRequest = yield* Queue.take(requests);
        expect(calls[1]).toEqual([t5]);
        expect(
          mixedStates.some(
            (state) =>
              AsyncResult.isSuccess(state) &&
              state.waiting &&
              Object.hasOwn(state.value as object, t1),
          ),
        ).toBe(true);
        yield* Deferred.succeed(mixedRequest, { [t5]: { title: "Five", projectId: null } });
        expect(yield* readEnvironmentQuery(registry, mixedAtom)).toEqual({
          [t1]: { title: "One", projectId },
          [t5]: { title: "Five", projectId: null },
        });

        // Removing t1 from the shell invalidates only t1 and re-fetches it immediately.
        registry.set(shellState, { removedAt: new Map([[t1, 10]]), generation: 0 });
        const invalidationRequest = yield* Queue.take(requests);
        expect(calls).toHaveLength(3);
        expect(calls[2]).toEqual([t1]);
        yield* Deferred.succeed(invalidationRequest, {});
        expect(yield* readEnvironmentQuery(registry, atomA)).toEqual({
          [t2]: { title: "Two", projectId },
        });

        // A same-session authoritative shell snapshot bumps generation and clears removedAt;
        // entries cached under generation 0 (including the t1 and t4 misses) coalesce into one re-check.
        registry.set(shellState, { removedAt: new Map(), generation: 1 });
        const snapshotResetRequest = yield* Queue.take(requests);
        expect(calls).toHaveLength(4);
        expect([...(calls[3] ?? [])].toSorted()).toEqual([t1, t2, t3, t4, t5]);
        yield* Deferred.succeed(snapshotResetRequest, {
          [t1]: { title: "Restored One", projectId },
          [t2]: { title: "Two", projectId },
          [t3]: { title: "Three", projectId: null },
          [t5]: { title: "Five", projectId: null },
        });
        expect(yield* readEnvironmentQuery(registry, atomA)).toEqual({
          [t1]: { title: "Restored One", projectId },
          [t2]: { title: "Two", projectId },
        });
      }),
  );

  it.effect(
    "expires cached threadLinkMetadata after 60 s and skips caching responses invalidated in flight",
    () =>
      Effect.gen(function* () {
        const calls: Array<ReadonlyArray<ThreadId>> = [];
        const requests =
          yield* Queue.unbounded<
            Deferred.Deferred<
              Record<string, { title: string; projectId: ProjectId | null }>,
              TestQueryError
            >
          >();
        const clock = yield* Clock.Clock;
        const rpcSession = {
          initialConfig: Effect.succeed({ threadLinkMetadata: true }),
          client: {
            [ORCHESTRATION_V2_WS_METHODS.getThreadLinkMetadata]: (input: {
              readonly threadIds: ReadonlyArray<ThreadId>;
            }) =>
              Effect.gen(function* () {
                calls.push(input.threadIds);
                const answer = yield* Deferred.make<
                  Record<string, { title: string; projectId: ProjectId | null }>,
                  TestQueryError
                >();
                yield* Queue.offer(requests, answer);
                return yield* Deferred.await(answer);
              }),
          },
        } as unknown as RpcSession.RpcSession;
        const supervisorState = yield* SubscriptionRef.make(queryConnectionState());
        const supervisorSession = yield* SubscriptionRef.make(Option.some(rpcSession));
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: QUERY_ENVIRONMENT,
          state: supervisorState,
          session: supervisorSession,
          prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
          _environmentId,
          effect,
        ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
          _environmentId,
          stream,
        ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run,
          followStream,
          stateChanges: () => SubscriptionRef.changes(supervisorState),
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Layer.succeed(Clock.Clock, clock),
          ),
        ) as unknown as Atom.AtomRuntime<
          EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient
        >;
        const shellState = Atom.make<Pick<EnvironmentShellState, "removedAt" | "generation">>({
          removedAt: new Map(),
          generation: 1,
        }).pipe(Atom.keepAlive);
        const orchestration = createOrchestrationEnvironmentAtoms(runtime, {
          shellState: () => shellState,
        });
        const t1 = ThreadId.make("ttl-1");
        const t2 = ThreadId.make("race-2");
        const tBystander = ThreadId.make("bystander-3");
        const tSubset = ThreadId.make("subset-4");
        const atom1 = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [t1, tSubset] },
        });
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const release1 = registry.mount(atom1);
        yield* Effect.addFinalizer(() => Effect.sync(release1));

        const req1 = yield* Queue.take(requests);
        yield* Deferred.succeed(req1, {
          [t1]: { title: "Before TTL", projectId: null },
          [tSubset]: { title: "Subset Before", projectId: null },
        });
        const beforeTtl = yield* readEnvironmentQuery(registry, atom1);
        expect(beforeTtl).toEqual({
          [t1]: { title: "Before TTL", projectId: null },
          [tSubset]: { title: "Subset Before", projectId: null },
        });
        expect(calls).toHaveLength(1);

        // Reading a subset key at t=59 s hits the cache without extending its 60 s expiry, and
        // unmounting drops its idle query node while keeping the per-thread cache warm until 60 s.
        yield* TestClock.adjust(59_000);
        const subsetAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tSubset] },
        });
        const releaseSubset1 = registry.mount(subsetAtom);
        expect(yield* readEnvironmentQuery(registry, subsetAtom)).toEqual({
          [tSubset]: { title: "Subset Before", projectId: null },
        });
        expect(calls).toHaveLength(1);
        releaseSubset1();

        // Reopening within 60 s hits the per-thread cache synchronously with zero RPCs.
        expect(registry.get(subsetAtom)).toMatchObject({
          _tag: "Success",
          waiting: false,
          value: { [tSubset]: { title: "Subset Before", projectId: null } },
        });
        expect(calls).toHaveLength(1);

        yield* TestClock.adjust(2_000);
        // After 60 s, the unmounted prefix key retains no stale idle Success result.
        const releaseSubset2 = registry.mount(subsetAtom);
        yield* Effect.addFinalizer(() => Effect.sync(releaseSubset2));
        expect(registry.get(subsetAtom)._tag).toBe("Initial");
        const reqSubsetAfterTtl = yield* Queue.take(requests);
        expect(calls).toHaveLength(2);
        yield* Deferred.succeed(reqSubsetAfterTtl, {
          [tSubset]: { title: "Subset After", projectId: null },
        });
        expect(yield* readEnvironmentQuery(registry, subsetAtom)).toEqual({
          [tSubset]: { title: "Subset After", projectId: null },
        });

        // Refreshing after TTL with equal data keeps referential identity.
        registry.refresh(atom1);
        const req2 = yield* Queue.take(requests);
        expect(calls).toHaveLength(3);
        yield* Deferred.succeed(req2, {
          [t1]: { title: "Before TTL", projectId: null },
        });
        const afterUnchangedTtl = yield* readEnvironmentQuery(registry, atom1);
        expect(afterUnchangedTtl).toEqual({
          [t1]: { title: "Before TTL", projectId: null },
          [tSubset]: { title: "Subset After", projectId: null },
        });

        // Re-fetching atom1 with identical payload preserves object reference through reuseUnchanged.
        yield* TestClock.adjust(60_001);
        registry.refresh(atom1);
        const req3 = yield* Queue.take(requests);
        expect(calls).toHaveLength(4);
        yield* Deferred.succeed(req3, {
          [t1]: { title: "Before TTL", projectId: null },
          [tSubset]: { title: "Subset After", projectId: null },
        });
        expect(yield* readEnvironmentQuery(registry, atom1)).toBe(afterUnchangedTtl);

        // Case A: if removedAt changes while an RPC is in flight, the stale response must not
        // overwrite the fresh cache entry. A bystander in the same batch (unaffected by t2's
        // removal) stays attached to `inflight` so awaiting it guarantees runAll completed.
        const atom2 = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [t2] },
        });
        const bystanderAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tBystander] },
        });
        const release2 = registry.mount(atom2);
        const releaseBystander = registry.mount(bystanderAtom);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            release2();
            releaseBystander();
          }),
        );
        const inflightRemoval = yield* Queue.take(requests);
        registry.set(shellState, { removedAt: new Map([[t2, 5]]), generation: 1 });
        const freshAfterRemoval = yield* Queue.take(requests);
        yield* Deferred.succeed(freshAfterRemoval, { [t2]: { title: "Fresh", projectId: null } });
        expect(yield* readEnvironmentQuery(registry, atom2)).toEqual({
          [t2]: { title: "Fresh", projectId: null },
        });
        yield* Deferred.succeed(inflightRemoval, {
          [t2]: { title: "Stale Removal", projectId: null },
          [tBystander]: { title: "Bystander", projectId: null },
        });
        expect(yield* readEnvironmentQuery(registry, bystanderAtom)).toEqual({
          [tBystander]: { title: "Bystander", projectId: null },
        });
        const callsAfterRemovalRace = calls.length;
        const verifyRemovalCache = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [t2, tBystander] },
        });
        expect(registry.get(verifyRemovalCache)).toMatchObject({
          _tag: "Success",
          waiting: false,
          value: {
            [t2]: { title: "Fresh", projectId: null },
            [tBystander]: { title: "Bystander", projectId: null },
          },
        });
        expect(calls).toHaveLength(callsAfterRemovalRace);

        // Case B: if a removal arrives and an authoritative shell snapshot clears removedAt back
        // to empty (bumping generation 1 -> 2), before/after both see removedAt=-1, so the
        // shell generation guard must block the older response from overwriting fresh metadata.
        const tSnap = ThreadId.make("snap-5");
        const snapAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tSnap] },
        });
        const releaseSnap = registry.mount(snapAtom);
        yield* Effect.addFinalizer(() => Effect.sync(releaseSnap));
        const inflightSnap = yield* Queue.take(requests);
        const snapshotGuardChecked = yield* Deferred.make<void>();
        let watchSnapshotGuard = false;
        registry.set(shellState, { removedAt: new Map([[tSnap, 9]]), generation: 1 });
        registry.set(shellState, {
          removedAt: new Map(),
          get generation() {
            if (watchSnapshotGuard) Deferred.doneUnsafe(snapshotGuardChecked, Exit.void);
            return 2;
          },
        });
        const freshAfterSnapshot = yield* Queue.take(requests);
        yield* Deferred.succeed(freshAfterSnapshot, {
          [tSnap]: { title: "Post-Snapshot Fresh", projectId: null },
        });
        expect(yield* readEnvironmentQuery(registry, snapAtom)).toEqual({
          [tSnap]: { title: "Post-Snapshot Fresh", projectId: null },
        });
        watchSnapshotGuard = true;
        yield* Deferred.succeed(inflightSnap, {
          [tSnap]: { title: "Pre-Snapshot Stale", projectId: null },
        });
        yield* Deferred.await(snapshotGuardChecked);
        // Yield once after the getter fired so the synchronous post-check body finishes.
        yield* Effect.yieldNow;
        const callsAfterSnapRace = calls.length;
        // Read tSnap through a fresh cold query key ([tSnap, tSnap]) so the assertion reads
        // straight from the per-thread cache instead of snapAtom's mounted value.
        const verifySnapCache = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tSnap, tSnap] },
        });
        expect(registry.get(verifySnapCache)).toMatchObject({
          _tag: "Success",
          waiting: false,
          value: { [tSnap]: { title: "Post-Snapshot Fresh", projectId: null } },
        });
        expect(calls).toHaveLength(callsAfterSnapRace);

        // Case C: growing streaming prefixes reuse in-flight lookups (fetching only new IDs even
        // when the earlier prefix unmounts), and failed in-flight lookups are cleared for retry.
        const tStreamA = ThreadId.make("stream-a-6");
        const tStreamB = ThreadId.make("stream-b-7");
        const prefixA = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tStreamA] },
        });
        const prefixAB = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tStreamA, tStreamB] },
        });
        const callsBeforeStream = calls.length;
        const releasePrefixA = registry.mount(prefixA);
        const reqStreamA = yield* Queue.take(requests);
        expect(calls[callsBeforeStream]).toEqual([tStreamA]);
        // Streaming moves to [A, B] and unmounts [A] (idleTtlMs: 0): [A, B] awaits A and fetches only B.
        const releasePrefixAB = registry.mount(prefixAB);
        yield* Effect.addFinalizer(() => Effect.sync(releasePrefixAB));
        releasePrefixA();
        const reqStreamB = yield* Queue.take(requests);
        expect(calls[callsBeforeStream + 1]).toEqual([tStreamB]);
        yield* Deferred.succeed(reqStreamB, {
          [tStreamB]: { title: "Stream B", projectId: null },
        });
        yield* Deferred.succeed(reqStreamA, {
          [tStreamA]: { title: "Stream A", projectId: null },
        });
        expect(yield* readEnvironmentQuery(registry, prefixAB)).toEqual({
          [tStreamA]: { title: "Stream A", projectId: null },
          [tStreamB]: { title: "Stream B", projectId: null },
        });
        expect(calls).toHaveLength(callsBeforeStream + 2);

        // Failed in-flight work is removed from the in-flight index so a retry fetches it again.
        const tFail = ThreadId.make("inflight-fail-8");
        const tOk = ThreadId.make("inflight-ok-9");
        const failOnlyAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tFail] },
        });
        const failAndOkAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tFail, tOk] },
        });
        const callsBeforeFail = calls.length;
        const releaseFailOnly = registry.mount(failOnlyAtom);
        yield* Effect.addFinalizer(() => Effect.sync(releaseFailOnly));
        const reqFail = yield* Queue.take(requests);
        expect(calls[callsBeforeFail]).toEqual([tFail]);
        const releaseFailAndOk = registry.mount(failAndOkAtom);
        yield* Effect.addFinalizer(() => Effect.sync(releaseFailAndOk));
        const reqOk = yield* Queue.take(requests);
        expect(calls[callsBeforeFail + 1]).toEqual([tOk]);
        yield* Deferred.fail(reqFail, new TestQueryError({ message: "inflight failed" }));
        yield* Deferred.succeed(reqOk, { [tOk]: { title: "Inflight OK", projectId: null } });

        const failOnlyExit = yield* Effect.exit(readEnvironmentQuery(registry, failOnlyAtom));
        expect(Exit.isFailure(failOnlyExit)).toBe(true);
        const failAndOkExit = yield* Effect.exit(readEnvironmentQuery(registry, failAndOkAtom));
        expect(Exit.isFailure(failAndOkExit)).toBe(true);
        if (Exit.isFailure(failAndOkExit)) {
          const partial = Option.getOrUndefined(Cause.findErrorOption(failAndOkExit.cause));
          expect(isPartialThreadLinkMetadataError(partial)).toBe(true);
          if (isPartialThreadLinkMetadataError(partial)) {
            expect(partial.metadata).toEqual({
              [tOk]: { title: "Inflight OK", projectId: null },
            });
            expect(partial.failedThreadIds).toEqual([tFail]);
          }
        }
        registry.refresh(failOnlyAtom);
        const retryFail = yield* Queue.take(requests);
        expect(calls[callsBeforeFail + 2]).toEqual([tFail]);
        yield* Deferred.succeed(retryFail, {
          [tFail]: { title: "Recovered Fail", projectId: null },
        });
        expect(yield* readEnvironmentQuery(registry, failOnlyAtom)).toEqual({
          [tFail]: { title: "Recovered Fail", projectId: null },
        });

        // Case D: flights superseded by a shell snapshot or thread removal during the batch delay
        // are rejected before dispatch, while current-generation flights in the same batch still run.
        const orderRegistry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => orderRegistry.dispose()));
        // Warm orderRegistry's AtomRuntime layer (0 RPCs) so subsequent mounts enter execute synchronously.
        const warmOrderAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [] },
        });
        const releaseWarm = orderRegistry.mount(warmOrderAtom);
        expect(yield* readEnvironmentQuery(orderRegistry, warmOrderAtom)).toEqual({});
        releaseWarm();

        const tOrder = ThreadId.make("order-10");
        const tOrderOther = ThreadId.make("order-other-11");
        const tOrderFresh = ThreadId.make("order-fresh-12");
        const tOrderRemoved = ThreadId.make("order-removed-13");
        const tOrderKept = ThreadId.make("order-kept-14");
        const tOrderAfterStale = ThreadId.make("order-after-stale-15");
        const olderAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tOrder, tOrderOther] },
        });
        const newerAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tOrder, tOrderFresh] },
        });
        const callsBeforeOrder = calls.length;
        const releaseOlder = orderRegistry.mount(olderAtom);
        releaseOlder();
        // Bump generation 1 -> 3 during the yieldNow delay and mount newerAtom in the same batch:
        // gen-1 flights are rejected without dispatching, and only [tOrder, tOrderFresh] is sent.
        orderRegistry.set(shellState, { removedAt: new Map(), generation: 3 });
        const releaseNewer = orderRegistry.mount(newerAtom);
        yield* Effect.addFinalizer(() => Effect.sync(releaseNewer));
        const newerReq = yield* Queue.take(requests);
        expect(calls).toHaveLength(callsBeforeOrder + 1);
        expect(calls[callsBeforeOrder]).toEqual([tOrder, tOrderFresh]);
        yield* Deferred.succeed(newerReq, {
          [tOrder]: { title: "Newer Title", projectId: null },
          [tOrderFresh]: { title: "Fresh Title", projectId: null },
        });
        expect(yield* readEnvironmentQuery(orderRegistry, newerAtom)).toEqual({
          [tOrder]: { title: "Newer Title", projectId: null },
          [tOrderFresh]: { title: "Fresh Title", projectId: null },
        });

        // A removal arriving during the batch delay rejects only the superseded removedAtSeq flight
        // while dispatching unaffected flights in the same batch.
        const staleRemovedAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tOrderRemoved, tOrderKept] },
        });
        const callsBeforeRemovedDelay = calls.length;
        const releaseStaleRemoved = orderRegistry.mount(staleRemovedAtom);
        releaseStaleRemoved();
        orderRegistry.set(shellState, { removedAt: new Map([[tOrderRemoved, 10]]), generation: 3 });
        const keptReq = yield* Queue.take(requests);
        expect(calls).toHaveLength(callsBeforeRemovedDelay + 1);
        expect(calls[callsBeforeRemovedDelay]).toEqual([tOrderKept]);
        yield* Deferred.succeed(keptReq, {
          [tOrderKept]: { title: "Kept Title", projectId: null },
        });
        const freshRemovedAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tOrderRemoved] },
        });
        const releaseFreshRemoved = orderRegistry.mount(freshRemovedAtom);
        yield* Effect.addFinalizer(() => Effect.sync(releaseFreshRemoved));
        const removedDelayReq = yield* Queue.take(requests);
        expect(calls[callsBeforeRemovedDelay + 1]).toEqual([tOrderRemoved]);
        yield* Deferred.succeed(removedDelayReq, {
          [tOrderRemoved]: { title: "Removed Fresh", projectId: null },
        });
        expect(yield* readEnvironmentQuery(orderRegistry, freshRemovedAtom)).toEqual({
          [tOrderRemoved]: { title: "Removed Fresh", projectId: null },
        });

        // A batch containing only superseded-generation flights dispatches zero RPCs and clears
        // its in-flight entries so a later lookup fetches normally.
        releaseNewer();
        releaseFreshRemoved();
        const staleOnlyAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tOrderOther] },
        });
        const staleBatchChecked = yield* Deferred.make<void>();
        const callsBeforeStaleOnly = calls.length;
        const releaseStaleOnly = orderRegistry.mount(staleOnlyAtom);
        releaseStaleOnly();
        orderRegistry.set(shellState, {
          removedAt: new Map(),
          get generation() {
            Deferred.doneUnsafe(staleBatchChecked, Exit.void);
            return 4;
          },
        });
        yield* Deferred.await(staleBatchChecked);
        const afterStaleAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [tOrderAfterStale, tOrderOther] },
        });
        const releaseAfterStale = orderRegistry.mount(afterStaleAtom);
        yield* Effect.addFinalizer(() => Effect.sync(releaseAfterStale));
        const afterStaleReq = yield* Queue.take(requests);
        expect(calls).toHaveLength(callsBeforeStaleOnly + 1);
        expect(calls[callsBeforeStaleOnly]).toEqual([tOrderAfterStale, tOrderOther]);
        yield* Deferred.succeed(afterStaleReq, {
          [tOrderAfterStale]: { title: "After Stale", projectId: null },
          [tOrderOther]: { title: "Gen 4 Other", projectId: null },
        });
        expect(yield* readEnvironmentQuery(orderRegistry, afterStaleAtom)).toEqual({
          [tOrderAfterStale]: { title: "After Stale", projectId: null },
          [tOrderOther]: { title: "Gen 4 Other", projectId: null },
        });
      }),
  );

  it.effect("chunks more than 500 ids and stops if the session is replaced between chunks", () =>
    Effect.gen(function* () {
      const session1Chunks: Array<ReadonlyArray<ThreadId>> = [];
      const session2Chunks: Array<ReadonlyArray<ThreadId>> = [];
      const firstChunkStarted = yield* Deferred.make<void>();
      const releaseFirstChunk = yield* Deferred.make<void>();
      const session1 = {
        initialConfig: Effect.succeed({ threadLinkMetadata: true }),
        client: {
          [ORCHESTRATION_V2_WS_METHODS.getThreadLinkMetadata]: (input: {
            readonly threadIds: ReadonlyArray<ThreadId>;
          }) =>
            Effect.gen(function* () {
              session1Chunks.push(input.threadIds);
              if (session1Chunks.length === 1) {
                yield* Deferred.succeed(firstChunkStarted, undefined);
                yield* Deferred.await(releaseFirstChunk);
              }
              return {};
            }),
        },
      } as unknown as RpcSession.RpcSession;
      const session2 = {
        initialConfig: Effect.succeed({ threadLinkMetadata: true }),
        client: {
          [ORCHESTRATION_V2_WS_METHODS.getThreadLinkMetadata]: (input: {
            readonly threadIds: ReadonlyArray<ThreadId>;
          }) =>
            Effect.sync(() => {
              session2Chunks.push(input.threadIds);
              return { "id-0": { title: "Recovered", projectId: null } };
            }),
        },
      } as unknown as RpcSession.RpcSession;
      const harness = yield* makeEnvironmentQueryHarness(Effect.void, { rpcSession: session1 });
      const runtime = harness.runtime as unknown as Atom.AtomRuntime<
        EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient
      >;
      const orchestration = createOrchestrationEnvironmentAtoms(runtime);
      const ids = Array.from({ length: 502 }, (_, index) => ThreadId.make(`id-${index}`));
      const atom = orchestration.threadLinkMetadata({
        environmentId: QUERY_ENVIRONMENT.environmentId,
        input: { threadIds: ids },
      });
      const registry = yield* mountEnvironmentQuery(atom);

      yield* Deferred.await(firstChunkStarted);
      expect(session1Chunks).toHaveLength(1);
      expect(session1Chunks[0]).toHaveLength(500);

      // Replace the session while chunk 1 is in flight: chunk 2 must NOT dispatch on session 1
      // or mix session 1's config with session 2's client; the query recovers on session 2.
      yield* SubscriptionRef.set(harness.supervisorSession, Option.some(session2));
      yield* SubscriptionRef.set(harness.supervisorState, queryConnectionState({ generation: 2 }));
      yield* Deferred.succeed(releaseFirstChunk, undefined);

      const result = yield* readEnvironmentQuery(registry, atom);
      expect(session1Chunks).toHaveLength(1);
      expect(session2Chunks.map((chunk) => chunk.length)).toEqual([500, 2]);
      expect(result).toEqual({ "id-0": { title: "Recovered", projectId: null } });
    }),
  );

  it.effect(
    "stops superseded chunked batches on shell snapshot and isolates unrelated chunk failures",
    () =>
      Effect.gen(function* () {
        const dispatchedChunks: Array<ReadonlyArray<ThreadId>> = [];
        const chunkRequests =
          yield* Queue.unbounded<
            Deferred.Deferred<
              Record<string, { title: string; projectId: ProjectId | null }>,
              TestQueryError
            >
          >();
        const harness = yield* makeEnvironmentQueryHarness(Effect.void, {
          rpcSession: {
            initialConfig: Effect.succeed({ threadLinkMetadata: true }),
            client: {
              [ORCHESTRATION_V2_WS_METHODS.getThreadLinkMetadata]: (input: {
                readonly threadIds: ReadonlyArray<ThreadId>;
              }) =>
                Effect.gen(function* () {
                  dispatchedChunks.push(input.threadIds);
                  const answer = yield* Deferred.make<
                    Record<string, { title: string; projectId: ProjectId | null }>,
                    TestQueryError
                  >();
                  yield* Queue.offer(chunkRequests, answer);
                  return yield* Deferred.await(answer);
                }),
            },
          } as unknown as RpcSession.RpcSession,
        });
        const shellState = Atom.make<Pick<EnvironmentShellState, "removedAt" | "generation">>({
          removedAt: new Map(),
          generation: 1,
        }).pipe(Atom.keepAlive);
        const runtime = harness.runtime as unknown as Atom.AtomRuntime<
          EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient
        >;
        const orchestration = createOrchestrationEnvironmentAtoms(runtime, {
          shellState: () => shellState,
        });
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));

        // 1. Same-session shell snapshot supersedes chunk 1: chunk 2 must NOT dispatch for gen 1.
        const genIds = Array.from({ length: 502 }, (_, index) => ThreadId.make(`gen-${index}`));
        const genAtom = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: genIds },
        });
        const releaseGen = registry.mount(genAtom);
        yield* Effect.addFinalizer(() => Effect.sync(releaseGen));
        const gen1Chunk1 = yield* Queue.take(chunkRequests);
        expect(dispatchedChunks.map((chunk) => chunk.length)).toEqual([500]);

        registry.set(shellState, { removedAt: new Map(), generation: 2 });
        const gen2Chunk1 = yield* Queue.take(chunkRequests);
        yield* Deferred.succeed(gen1Chunk1, {
          "gen-0": { title: "Stale Gen 1", projectId: null },
        });
        yield* Deferred.succeed(gen2Chunk1, {
          "gen-0": { title: "Fresh Gen 2", projectId: null },
        });
        const gen2Chunk2 = yield* Queue.take(chunkRequests);
        yield* Deferred.succeed(gen2Chunk2, {
          "gen-501": { title: "Tail Gen 2", projectId: null },
        });
        expect(yield* readEnvironmentQuery(registry, genAtom)).toEqual({
          "gen-0": { title: "Fresh Gen 2", projectId: null },
          "gen-501": { title: "Tail Gen 2", projectId: null },
        });
        // Total dispatched chunks: 1 from gen 1 (chunk 2 skipped) + 2 from gen 2.
        expect(dispatchedChunks.map((chunk) => chunk.length)).toEqual([500, 500, 2]);

        // 2. Shared batch across chunk 1 and chunk 2: callerA (499 IDs), callerB (spanning chunk 1
        // miss + chunk 1 hit + chunk 2 failure), and callerC (chunk 2 only) enter the same batch.
        // Chunk 1 (500 IDs ending with iso-499) proves callerA and callerB shared the batch and
        // only chunk 1 dispatched before its reply is released.
        const callerAIds = Array.from({ length: 499 }, (_, index) => ThreadId.make(`iso-${index}`));
        const iso498 = ThreadId.make("iso-498");
        const iso499 = ThreadId.make("iso-499");
        const iso500 = ThreadId.make("iso-500");
        const iso501 = ThreadId.make("iso-501");
        const iso502 = ThreadId.make("iso-502");
        const callerA = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: callerAIds },
        });
        const callerB = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [iso498, iso499, iso500] },
        });
        const callerC = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [iso501] },
        });
        const callerD = orchestration.threadLinkMetadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: { threadIds: [iso502] },
        });
        const callsBeforeIso = dispatchedChunks.length;
        const releaseA = registry.mount(callerA);
        const releaseB = registry.mount(callerB);
        const releaseC = registry.mount(callerC);
        const releaseD = registry.mount(callerD);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releaseA();
            releaseB();
            releaseC();
          }),
        );
        const isoChunk1 = yield* Queue.take(chunkRequests);
        expect(dispatchedChunks).toHaveLength(callsBeforeIso + 1);
        expect(dispatchedChunks[callsBeforeIso]).toHaveLength(500);
        expect(dispatchedChunks[callsBeforeIso]?.at(-1)).toBe(iso499);
        // Remove iso502 while chunk 1 is held: chunk 2 skips the superseded flight instead of sending it.
        releaseD();
        registry.set(shellState, { removedAt: new Map([[iso502, 1]]), generation: 2 });
        yield* Deferred.succeed(isoChunk1, {
          "iso-0": { title: "Chunk 1 OK", projectId: null },
          [iso499]: { title: "Spanning OK", projectId: null },
        });
        expect(yield* readEnvironmentQuery(registry, callerA)).toEqual({
          "iso-0": { title: "Chunk 1 OK", projectId: null },
        });
        const isoChunk2 = yield* Queue.take(chunkRequests);
        expect(dispatchedChunks).toHaveLength(callsBeforeIso + 2);
        expect(dispatchedChunks[callsBeforeIso + 1]).toEqual([iso500, iso501]);
        yield* Deferred.fail(isoChunk2, new TestQueryError({ message: "chunk 2 failed" }));

        // Spanning callerB receives chunk 1's succeeded metadata and keeps only iso500 failed.
        const callerBExit = yield* Effect.exit(readEnvironmentQuery(registry, callerB));
        expect(Exit.isFailure(callerBExit)).toBe(true);
        if (Exit.isFailure(callerBExit)) {
          const partial = Option.getOrUndefined(Cause.findErrorOption(callerBExit.cause));
          expect(isPartialThreadLinkMetadataError(partial)).toBe(true);
          if (isPartialThreadLinkMetadataError(partial)) {
            expect(partial.metadata).toEqual({
              [iso499]: { title: "Spanning OK", projectId: null },
            });
            expect(partial.failedThreadIds).toEqual([iso500]);
          }
        }
        expect(AsyncResult.getOrElse(registry.get(callerB), () => null)).toEqual({
          [iso499]: { title: "Spanning OK", projectId: null },
        });

        // Chunk-2-only callerC fails with the underlying error (not a partial error).
        const callerCExit = yield* Effect.exit(readEnvironmentQuery(registry, callerC));
        expect(Exit.isFailure(callerCExit)).toBe(true);
        if (Exit.isFailure(callerCExit)) {
          const err = Option.getOrUndefined(Cause.findErrorOption(callerCExit.cause));
          expect(isTestQueryError(err)).toBe(true);
        }

        // Retrying callerB hits cache for iso498 (miss) and iso499 (hit) and fetches only iso500.
        const callsBeforeRetry = dispatchedChunks.length;
        registry.refresh(callerB);
        const retryB = yield* Queue.take(chunkRequests);
        expect(dispatchedChunks).toHaveLength(callsBeforeRetry + 1);
        expect(dispatchedChunks[callsBeforeRetry]).toEqual([iso500]);
        yield* Deferred.succeed(retryB, {
          [iso500]: { title: "Chunk 2 Retried", projectId: null },
        });
        expect(yield* readEnvironmentQuery(registry, callerB)).toEqual({
          [iso499]: { title: "Spanning OK", projectId: null },
          [iso500]: { title: "Chunk 2 Retried", projectId: null },
        });

        // Retrying callerC fetches iso501 (not cached as a miss) and succeeds.
        registry.refresh(callerC);
        const retryC = yield* Queue.take(chunkRequests);
        expect(dispatchedChunks[callsBeforeRetry + 1]).toEqual([iso501]);
        yield* Deferred.succeed(retryC, {
          [iso501]: { title: "Caller C Retried", projectId: null },
        });
        expect(yield* readEnvironmentQuery(registry, callerC)).toEqual({
          [iso501]: { title: "Caller C Retried", projectId: null },
        });
      }),
  );

  it.effect("re-checks thread titles when one of their threads leaves the shell", () =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<Deferred.Deferred<Record<string, string>>>();
      const harness = yield* makeEnvironmentQueryHarness(Effect.void, {
        rpcSession: {
          client: {
            [ORCHESTRATION_V2_WS_METHODS.getThreadTitles]: () =>
              Effect.gen(function* () {
                const answer = yield* Deferred.make<Record<string, string>>();
                yield* Queue.offer(requests, answer);
                return yield* Deferred.await(answer);
              }),
          },
        } as unknown as RpcSession.RpcSession,
      });
      const shellState = Atom.make<Pick<EnvironmentShellState, "removedAt" | "generation">>({
        removedAt: new Map(),
        generation: 0,
      }).pipe(Atom.keepAlive);
      const removed = (entries: ReadonlyArray<readonly [string, number]>) => ({
        removedAt: new Map(entries.map(([id, sequence]) => [ThreadId.make(id), sequence])),
        generation: 0,
      });
      // Thread titles never use the HTTP client.
      const runtime = harness.runtime as unknown as Atom.AtomRuntime<
        EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient
      >;
      const atom = createOrchestrationEnvironmentAtoms(runtime, {
        shellState: () => shellState,
      }).threadTitles({
        environmentId: QUERY_ENVIRONMENT.environmentId,
        input: { threadIds: [ThreadId.make("fork")] },
      });
      const registry = yield* mountEnvironmentQuery(atom);
      const settled: Array<Record<string, string>> = [];
      const unsubscribe = registry.subscribe(atom, (result) => {
        if (AsyncResult.isSuccess(result) && !result.waiting) settled.push(result.value);
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* Deferred.succeed(yield* Queue.take(requests), { fork: "Fork" });
      expect(yield* readEnvironmentQuery(registry, atom)).toEqual({ fork: "Fork" });

      registry.set(shellState, removed([["other", 5]]));
      expect(registry.get(atom).waiting).toBe(false);

      // Archiving and then deleting the fork both remove it from the shell.
      registry.set(shellState, removed([["fork", 6]]));
      const beforeDelete = yield* Queue.take(requests);
      registry.set(shellState, removed([["fork", 7]]));
      const afterDelete = yield* Queue.take(requests);
      yield* Deferred.succeed(beforeDelete, { fork: "Fork" });
      yield* Deferred.succeed(afterDelete, {});
      expect(yield* readEnvironmentQuery(registry, atom)).toEqual({});
      expect(settled).toEqual([{ fork: "Fork" }, {}]);
    }),
  );

  it.effect("re-reads an open archive when a thread leaves the shell", () =>
    Effect.gen(function* () {
      const requests =
        yield* Queue.unbounded<Deferred.Deferred<OrchestrationV2ArchivedShellSnapshot>>();
      const harness = yield* makeEnvironmentQueryHarness(Effect.void, {
        rpcSession: {
          client: {
            [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: () =>
              Effect.gen(function* () {
                const answer = yield* Deferred.make<OrchestrationV2ArchivedShellSnapshot>();
                yield* Queue.offer(requests, answer);
                return yield* Deferred.await(answer);
              }),
          },
        } as unknown as RpcSession.RpcSession,
      });
      const shellState = Atom.make<Pick<EnvironmentShellState, "removedAt" | "generation">>({
        removedAt: new Map(),
        generation: 0,
      }).pipe(Atom.keepAlive);
      const runtime = harness.runtime as unknown as Atom.AtomRuntime<
        EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient
      >;
      const atom = createOrchestrationEnvironmentAtoms(runtime, {
        shellState: () => shellState,
      }).archivedShellSnapshot({ environmentId: QUERY_ENVIRONMENT.environmentId, input: {} });
      const page = (threads: OrchestrationV2ArchivedShellSnapshot["threads"]) => ({
        schemaVersion: 1,
        snapshotSequence: 1,
        projects: [v2Project],
        threads,
      });
      const registry = yield* mountEnvironmentQuery(atom);
      const archivedIds = Effect.map(readEnvironmentQuery(registry, atom), (snapshot) =>
        snapshot.threads.map((thread) => thread.id),
      );
      yield* Deferred.succeed(yield* Queue.take(requests), page([]));
      expect(yield* archivedIds).toEqual([]);

      // Another client archives the thread, then deletes it from the archive.
      registry.set(shellState, { removedAt: new Map([[v2ThreadId, 2]]), generation: 0 });
      expect(registry.get(atom).waiting).toBe(true);
      yield* Deferred.succeed(
        yield* Queue.take(requests),
        page([{ ...v2ThreadShell, archivedAt: v2Now }]),
      );
      expect(yield* archivedIds).toEqual([v2ThreadId]);
      registry.set(shellState, { removedAt: new Map([[v2ThreadId, 3]]), generation: 0 });
      yield* Deferred.succeed(yield* Queue.take(requests), page([]));
      expect(yield* archivedIds).toEqual([]);
    }),
  );
});

describe("executeAtomQuery", () => {
  it("keeps concurrent query results correlated to their atoms", async () => {
    const firstLatch = Latch.makeUnsafe();
    const secondLatch = Latch.makeUnsafe();
    const firstAtom = Atom.make(firstLatch.await.pipe(Effect.as("first")));
    const secondAtom = Atom.make(secondLatch.await.pipe(Effect.as("second")));
    const registry = AtomRegistry.make();

    const firstResult = executeAtomQuery(registry, firstAtom);
    const secondResult = executeAtomQuery(registry, secondAtom);

    secondLatch.openUnsafe();
    firstLatch.openUnsafe();

    const [first, second] = await Promise.all([firstResult, secondResult]);
    expect(first._tag).toBe("Success");
    expect(second._tag).toBe("Success");
    if (first._tag === "Success" && second._tag === "Success") {
      expect(first.value).toBe("first");
      expect(second.value).toBe("second");
    }

    registry.dispose();
  });

  it("settles when its caller aborts a waiting query", async () => {
    const registry = AtomRegistry.make();
    const controller = new AbortController();
    const resultPromise = executeAtomQuery(registry, Atom.make(Effect.never), {
      reportDefect: false,
      signal: controller.signal,
    });

    controller.abort();

    const result = await resultPromise;
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(result.cause)).toBe(true);
    }
    registry.dispose();
  });
});

describe("runtime command runner", () => {
  const start = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.forkChild(Effect.exit(effect), { startImmediately: true });

  it.effect("fails the run with a defect when its lane key throws", () =>
    Effect.gen(function* () {
      const defect = new Error("invalid command key");
      const command = createRuntimeCommand(Atom.runtime(Layer.empty), {
        label: "test.invalid-key",
        concurrency: {
          mode: "serial",
          key: () => {
            throw defect;
          },
        },
        execute: () => Effect.void,
      });
      const registry = AtomRegistry.make();

      const exit = yield* Effect.exit(command.run(registry, undefined));
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect);
      registry.dispose();
    }),
  );

  it.effect("stops a command when its caller is interrupted", () =>
    Effect.gen(function* () {
      const started = Latch.makeUnsafe();
      let stopped = false;
      const command = createRuntimeCommand(Atom.runtime(Layer.empty), {
        label: "test.interrupt",
        execute: () =>
          Effect.sync(() => started.openUnsafe()).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                stopped = true;
              }),
            ),
          ),
      });
      const registry = AtomRegistry.make();

      const run = yield* start(command.run(registry, undefined));
      yield* started.await;
      yield* Fiber.interrupt(run);

      expect(stopped).toBe(true);
      registry.dispose();
    }),
  );

  it.effect("serializes a lane, and skips a queued command its caller stopped waiting for", () =>
    Effect.gen(function* () {
      const firstStarted = Latch.makeUnsafe();
      const firstLatch = Latch.makeUnsafe();
      const events: string[] = [];
      const runtime = Atom.runtime(Layer.empty);
      const scheduler = createAtomCommandScheduler();
      const concurrency = { mode: "serial" as const, key: () => "shared" };
      const firstCommand = createRuntimeCommand(runtime, {
        label: "test.first",
        scheduler,
        concurrency,
        execute: () =>
          Effect.sync(() => {
            events.push("first:start");
            firstStarted.openUnsafe();
          }).pipe(
            Effect.andThen(firstLatch.await),
            Effect.tap(() => Effect.sync(() => events.push("first:end"))),
          ),
      });
      const queuedCommand = createRuntimeCommand(runtime, {
        label: "test.queued",
        scheduler,
        concurrency,
        execute: (name: string) => Effect.sync(() => events.push(`${name}:start`)),
      });
      const registry = AtomRegistry.make();

      const first = yield* start(firstCommand.run(registry, undefined));
      yield* firstStarted.await;
      const abandoned = yield* start(queuedCommand.run(registry, "abandoned"));
      const third = yield* start(queuedCommand.run(registry, "third"));
      yield* Fiber.interrupt(abandoned);
      expect(events).toEqual(["first:start"]);

      firstLatch.openUnsafe();
      yield* Fiber.join(first);
      yield* Fiber.join(third);
      expect(events).toEqual(["first:start", "first:end", "third:start"]);
      registry.dispose();
    }),
  );

  it.effect("releases a shared scheduler lane before the outer command finishes", () =>
    Effect.gen(function* () {
      const handoffStarted = Latch.makeUnsafe();
      const handoffComplete = Latch.makeUnsafe();
      const resumeComplete = Latch.makeUnsafe();
      const runtime = Atom.runtime(Layer.empty);
      const scheduler = createAtomCommandScheduler();
      const concurrency = { mode: "serial" as const, key: () => "shared" };
      const updateCommand = createRuntimeCommand(runtime, {
        label: "test.update",
        execute: (_input: void, registry) =>
          scheduler
            .schedule(
              registry,
              concurrency,
              undefined,
              Effect.sync(() => handoffStarted.openUnsafe()).pipe(
                Effect.andThen(handoffComplete.await),
              ),
            )
            .pipe(Effect.andThen(resumeComplete.await)),
      });
      const configCommand = createRuntimeCommand(runtime, {
        label: "test.config",
        scheduler,
        concurrency,
        execute: () => Effect.succeed("configured"),
      });
      const registry = AtomRegistry.make();

      const update = yield* start(updateCommand.run(registry, undefined));
      yield* handoffStarted.await;
      const config = yield* start(configCommand.run(registry, undefined));
      handoffComplete.openUnsafe();

      expect(yield* Fiber.join(config)).toEqual(Exit.succeed("configured"));
      resumeComplete.openUnsafe();
      expect(Exit.isSuccess(yield* Fiber.join(update))).toBe(true);
      registry.dispose();
    }),
  );

  it.effect("keeps an outer reconnect observer alive after a scheduled handoff returns", () =>
    Effect.gen(function* () {
      const commitStarting = yield* Deferred.make<void>();
      const observerArmed = yield* Deferred.make<void>();
      const reconnected = yield* Deferred.make<void>();
      const states = yield* Queue.unbounded<{ readonly phase: string }>();
      yield* Queue.offer(states, { phase: "connected" });
      const scheduler = createAtomCommandScheduler();
      const concurrency = { mode: "serial" as const, key: () => "shared" };
      const command = createRuntimeCommand(Atom.runtime(Layer.empty), {
        label: "test.desktop-update-handoff",
        execute: (_input: void, registry) =>
          Effect.gen(function* () {
            yield* Deferred.await(commitStarting).pipe(
              Effect.andThen(
                Stream.fromQueue(states).pipe(
                  Stream.tap(() => Deferred.succeed(observerArmed, undefined)),
                  Stream.dropWhile((state) => state.phase === "connected"),
                  Stream.filter((state) => state.phase === "connected"),
                  Stream.runHead,
                ),
              ),
              Effect.andThen(Deferred.succeed(reconnected, undefined)),
              Effect.forkChild,
            );
            yield* scheduler.schedule(
              registry,
              concurrency,
              undefined,
              Deferred.succeed(commitStarting, undefined).pipe(
                Effect.andThen(Deferred.await(observerArmed)),
              ),
            );
            yield* Queue.offer(states, { phase: "backoff" });
            yield* Queue.offer(states, { phase: "connected" });
            yield* Deferred.await(reconnected);
          }),
      });
      const registry = AtomRegistry.make();

      yield* command.run(registry, undefined);
      registry.dispose();
    }),
  );

  it.effect("shares a single-flight run, which stops once its last caller stops waiting", () =>
    Effect.gen(function* () {
      const started = Latch.makeUnsafe();
      let executions = 0;
      let stopped = false;
      const command = createRuntimeCommand(Atom.runtime(Layer.empty), {
        label: "test.single-flight",
        concurrency: { mode: "singleFlight", key: (key: string) => key },
        execute: () =>
          Effect.sync(() => {
            executions++;
            started.openUnsafe();
          }).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                stopped = true;
              }),
            ),
          ),
      });
      const registry = AtomRegistry.make();

      const first = yield* start(command.run(registry, "same"));
      const second = yield* start(command.run(registry, "same"));
      yield* started.await;
      yield* Fiber.interrupt(first);
      expect({ executions, stopped }).toEqual({ executions: 1, stopped: false });

      yield* Fiber.interrupt(second);
      expect(stopped).toBe(true);
      registry.dispose();
    }),
  );

  it.effect("gives every single-flight caller the shared result", () =>
    Effect.gen(function* () {
      const latch = Latch.makeUnsafe();
      let executions = 0;
      const command = createRuntimeCommand(Atom.runtime(Layer.empty), {
        label: "test.single-flight",
        concurrency: { mode: "singleFlight", key: (key: string) => key },
        execute: () =>
          Effect.sync(() => executions++).pipe(Effect.andThen(latch.await), Effect.as("done")),
      });
      const registry = AtomRegistry.make();

      const first = yield* start(command.run(registry, "same"));
      const second = yield* start(command.run(registry, "same"));
      latch.openUnsafe();

      expect(yield* Fiber.join(first)).toEqual(Exit.succeed("done"));
      expect(yield* Fiber.join(second)).toEqual(Exit.succeed("done"));
      expect(executions).toBe(1);
      registry.dispose();
    }),
  );

  it.effect("coalesces queued latest-value commands, and drops one nobody waits for", () =>
    Effect.gen(function* () {
      const firstStarted = Latch.makeUnsafe();
      const firstLatch = Latch.makeUnsafe();
      const executed: number[] = [];
      const command = createRuntimeCommand(Atom.runtime(Layer.empty), {
        label: "test.latest",
        concurrency: { mode: "latest", key: () => "shared" },
        execute: (value: number) =>
          Effect.sync(() => {
            executed.push(value);
            firstStarted.openUnsafe();
          }).pipe(Effect.andThen(value === 1 ? firstLatch.await : Effect.void), Effect.as(value)),
      });
      const registry = AtomRegistry.make();

      const first = yield* start(command.run(registry, 1));
      yield* firstStarted.await;
      const second = yield* start(command.run(registry, 2));
      const third = yield* start(command.run(registry, 3));
      firstLatch.openUnsafe();

      expect(yield* Fiber.join(first)).toEqual(Exit.succeed(1));
      expect(yield* Fiber.join(second)).toEqual(Exit.succeed(3));
      expect(yield* Fiber.join(third)).toEqual(Exit.succeed(3));
      expect(executed).toEqual([1, 3]);

      firstLatch.closeUnsafe();
      const running = yield* start(command.run(registry, 1));
      const abandoned = yield* start(command.run(registry, 4));
      yield* Fiber.interrupt(abandoned);
      firstLatch.openUnsafe();
      yield* Fiber.join(running);
      expect(executed).toEqual([1, 3, 1]);
      registry.dispose();
    }),
  );
});

describe("persisted environment queries", () => {
  it.effect("keeps an in-memory cached page pending until revalidation settles", () =>
    Effect.gen(function* () {
      const refreshStarted = Latch.makeUnsafe();
      const finishRefresh = Latch.makeUnsafe();
      let executions = 0;
      const harness = yield* makeEnvironmentQueryHarness(
        Effect.suspend(() => {
          if (++executions === 1) return Effect.succeed("cached");
          refreshStarted.openUnsafe();
          return finishRefresh.await.pipe(Effect.as("fresh"));
        }),
        { persistence: { load: () => Effect.succeedNone, save: () => Effect.void } },
      );
      const registry = yield* mountEnvironmentQuery(harness.atom);
      expect(yield* readEnvironmentQuery(registry, harness.atom)).toBe("cached");
      registry.refresh(harness.atom);
      yield* refreshStarted.await;
      expect(registry.get(harness.atom)).toMatchObject({
        _tag: "Success",
        value: "cached",
        waiting: true,
      });
      finishRefresh.openUnsafe();
      expect(yield* readEnvironmentQuery(registry, harness.atom)).toBe("fresh");
    }),
  );

  it.effect(
    "restores cached data in a new registry while offline, then refreshes on reconnect",
    () =>
      Effect.gen(function* () {
        let saved = Option.none<string>();
        const saves = yield* Queue.unbounded<string>();
        const persistence: QueryPersistence<string> = {
          load: () => Effect.sync(() => saved),
          save: (_environmentId, _key, value) =>
            Effect.sync(() => {
              saved = Option.some(value);
            }).pipe(Effect.andThen(Queue.offer(saves, value))),
        };
        const first = yield* makeEnvironmentQueryHarness(Effect.succeed("first"), {
          persistence,
        });
        const firstRegistry = yield* mountEnvironmentQuery(first.atom);
        expect(yield* readEnvironmentQuery(firstRegistry, first.atom)).toBe("first");
        expect(yield* Queue.take(saves)).toBe("first");

        const restarted = yield* makeEnvironmentQueryHarness(Effect.succeed("updated"), {
          persistence,
          initialState: queryConnectionState({ phase: "offline", network: "offline" }),
        });
        const registry = yield* mountEnvironmentQuery(restarted.atom);
        expect(yield* readEnvironmentQuery(registry, restarted.atom)).toBe("first");
        yield* SubscriptionRef.set(restarted.supervisorState, queryConnectionState());
        yield* Effect.yieldNow;
        expect(yield* readEnvironmentQuery(registry, restarted.atom)).toBe("updated");
        expect(yield* Queue.take(saves)).toBe("updated");
      }),
  );

  it.effect("answers readers while its save is pending, and ends the save with the query", () =>
    Effect.gen(function* () {
      const saveEnded = Latch.makeUnsafe();
      const harness = yield* makeEnvironmentQueryHarness(Effect.succeed("fresh"), {
        persistence: {
          load: () => Effect.succeedNone,
          // The registry's scheduler stops on dispose, so signal synchronously.
          save: () =>
            Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => saveEnded.openUnsafe()))),
        },
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* mountEnvironmentQuery(harness.atom);
          expect(yield* readEnvironmentQuery(registry, harness.atom)).toBe("fresh");
        }),
      );
      yield* saveEnded.await;
    }),
  );

  it.effect("hands each server answer to onAnswer before readers see it", () =>
    Effect.gen(function* () {
      const answers: Array<readonly [string, string | null]> = [];
      let served = 0;
      const recorded = Atom.make<string | null>(null).pipe(Atom.keepAlive);
      const harness = yield* makeEnvironmentQueryHarness(
        Effect.sync(() => `answer-${++served}`),
        {
          onAnswer: (_target, value, registry) =>
            Effect.sync(() => {
              answers.push([value, registry.get(recorded)]);
              registry.set(recorded, value);
            }),
        },
      );
      const registry = yield* mountEnvironmentQuery(harness.atom);
      expect(yield* readEnvironmentQuery(registry, harness.atom)).toBe("answer-1");
      expect(registry.get(recorded)).toBe("answer-1");
      registry.refresh(harness.atom);
      expect(yield* readEnvironmentQuery(registry, harness.atom)).toBe("answer-2");
      expect(answers).toEqual([
        ["answer-1", null],
        ["answer-2", "answer-1"],
      ]);
    }),
  );

  it.effect("does not hand a value restored from persistence to onAnswer", () =>
    Effect.gen(function* () {
      const answers: Array<string> = [];
      const harness = yield* makeEnvironmentQueryHarness(Effect.succeed("server"), {
        persistence: { load: () => Effect.succeedSome("cached"), save: () => Effect.void },
        initialState: queryConnectionState({ phase: "offline", network: "offline" }),
        onAnswer: (_target, value) => Effect.sync(() => answers.push(value)),
      });
      const registry = yield* mountEnvironmentQuery(harness.atom);
      expect(yield* readEnvironmentQuery(registry, harness.atom)).toBe("cached");
      expect(answers).toEqual([]);
      yield* SubscriptionRef.set(harness.supervisorState, queryConnectionState());
      yield* Effect.yieldNow;
      expect(yield* readEnvironmentQuery(registry, harness.atom)).toBe("server");
      expect(answers).toEqual(["server"]);
    }),
  );

  it.effect("keeps cached content available when revalidation fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeEnvironmentQueryHarness(
        Effect.fail(new TestQueryError({ message: "failed" })),
        {
          persistence: { load: () => Effect.succeedSome("cached"), save: () => Effect.void },
        },
      );
      const registry = yield* mountEnvironmentQuery(harness.atom);
      yield* Effect.result(readEnvironmentQuery(registry, harness.atom));
      expect(AsyncResult.getOrElse(registry.get(harness.atom), () => null)).toBe("cached");
    }),
  );
});
