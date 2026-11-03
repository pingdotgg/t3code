import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type PreviewEvent,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
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
import type * as RpcSession from "../rpc/session.ts";
import { createPreviewEnvironmentAtoms } from "./preview.ts";
import type { QueryPersistence } from "./queryPersistence.ts";
import { createTerminalEnvironmentAtoms } from "./terminal.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentQueryAtomFamily,
  selectEnvironmentQueryData,
  createEnvironmentSubscriptionAtomFamily,
  createRuntimeCommand,
  environmentSessionGenerationAtom,
  scheduleAtomCommandEffect,
  executeAtomQuery,
  type QueryAnswerHandler,
} from "./runtime.ts";

const QUERY_ENVIRONMENT = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("query-environment"),
  label: "Query environment",
  httpBaseUrl: "https://query.example.test",
  wsBaseUrl: "wss://query.example.test",
});

const QUERY_RPC_SESSION = {} as RpcSession.RpcSession;

class TestQueryError extends Schema.TaggedError<TestQueryError>()("TestQueryError", {
  message: Schema.String,
}) {}

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

const mountEnvironmentQuery = Effect.fn("TestEnvironmentQuery.mount")(function* <A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
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

describe("preview event subscriptions", () => {
  it.effect("delivers every open and close when RPC events arrive in batches", () =>
    Effect.scoped(
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
    ),
  );
});

describe("finite environment subscription lifecycle", () => {
  it.effect(
    "exposes early values and settles on the terminal value without waiting for a reconnect",
    () =>
      Effect.scoped(
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
      ),
  );
});

describe("environment query lifecycle", () => {
  it.effect(
    "terminal metadata waits for snapshots and retains known sessions across restarts",
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
        const atom = atoms.metadata({
          environmentId: QUERY_ENVIRONMENT.environmentId,
          input: null,
        });
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

        yield* Queue.offer(events, { type: "snapshot", terminals: [checkout] });
        yield* Deferred.await(receivedCheckout);
        expect(selectEnvironmentQueryData(registry.get(atom))).toEqual([checkout]);

        yield* SubscriptionRef.set(harness.supervisorSession, Option.some({ ...session }));
        yield* Queue.take(started);
        expect(selectEnvironmentQueryData(registry.get(atom))).toEqual([checkout]);

        yield* SubscriptionRef.update(harness.streamGeneration, (generation) => generation + 1);
        yield* Queue.take(started);
        expect(selectEnvironmentQueryData(registry.get(atom))).toEqual([checkout]);

        yield* Queue.offer(events, { type: "snapshot", terminals: [] });
        yield* Deferred.await(receivedEmpty);
        expect(selectEnvironmentQueryData(registry.get(atom))).toEqual([]);
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

      expect(yield* Queue.take(inputs)).toEqual(input);
      yield* SubscriptionRef.set(harness.supervisorSession, Option.some({ ...firstSession }));
      expect(yield* Queue.take(inputs)).toEqual(input);
      yield* Queue.offer(events, {
        type: "closed",
        threadId: input.threadId,
        terminalId: input.terminalId,
      });
      yield* Deferred.await(received);

      yield* SubscriptionRef.set(harness.supervisorSession, Option.some({ ...firstSession }));
      expect(yield* Queue.take(inputs)).toEqual({ ...input, resume: true });
      // Catalog replacements rerun the same stream through followStream's switchMap.
      yield* SubscriptionRef.update(harness.streamGeneration, (generation) => generation + 1);
      expect(yield* Queue.take(inputs)).toEqual({ ...input, resume: true });

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
      expect(yield* Queue.take(inputs)).toEqual(input);
    }),
  );

  it.effect(
    "hides a session replacement, reports the relay backoff, and recovers on reconnect",
    () =>
      Effect.scoped(
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
      ),
  );

  it.effect("keeps a query pending when it loses its session before the atom sees the change", () =>
    Effect.scoped(
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
        yield* SubscriptionRef.set(
          harness.supervisorState,
          queryConnectionState({ generation: 2 }),
        );
        expect(
          yield* AtomRegistry.getResult(registry, harness.atom, {
            suspendOnWaiting: true,
          }),
        ).toBe("recovered");
        expect(observed.some(AsyncResult.isFailure)).toBe(false);
      }),
    ),
  );

  it.effect("fails a query that reports unavailable while its session is still live", () =>
    Effect.scoped(
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
    ),
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
    Effect.scoped(
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
    ),
  );

  it.effect.each([
    { phase: "backoff", stage: null, retryAt: 1 },
    { phase: "connecting", stage: "opening", retryAt: null },
  ] as const)(
    "settles a query it never answered while its environment retries ($phase)",
    (retrying) =>
      Effect.scoped(
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
      ),
  );

  it.effect("a refresh started on a new session generation answers from that session", () =>
    Effect.scoped(
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
        yield* SubscriptionRef.set(
          harness.supervisorState,
          queryConnectionState({ generation: 2 }),
        );
        expect(yield* Deferred.await(answered)).toMatchObject({
          _tag: "Success",
          value: "connected",
        });
      }),
    ),
  );

  it.effect("keeps a genuine query failure settled while reconnecting", () =>
    Effect.scoped(
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

        yield* SubscriptionRef.set(
          harness.supervisorState,
          queryConnectionState({ generation: 2 }),
        );
        yield* refreshStarted.await;
        finishRefresh.openUnsafe();
        expect(
          yield* AtomRegistry.getResult(registry, harness.atom, {
            suspendOnWaiting: true,
          }),
        ).toBe("recovered");
      }),
    ),
  );

  it.effect("retains the last successful value while reconnecting", () =>
    Effect.scoped(
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

        yield* SubscriptionRef.set(
          harness.supervisorState,
          queryConnectionState({ generation: 2 }),
        );
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
    ),
  );

  it.effect("refreshes on its trigger while read, and once on its next read when idle", () =>
    Effect.scoped(
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
    ),
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
  it("settles generated command scheduler defects from direct callers", async () => {
    const defect = new Error("invalid command key");
    const runtime = Atom.runtime(Layer.empty);
    const command = createRuntimeCommand(runtime, {
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

    const result = await command.run(registry, undefined);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.hasDies(result.cause)).toBe(true);
      expect(Cause.squash(result.cause)).toBe(defect);
    }
    registry.dispose();
  });

  it("serializes commands that share a scheduler and lane", async () => {
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
        Effect.sync(() => events.push("first:start")).pipe(
          Effect.andThen(firstLatch.await),
          Effect.tap(() => Effect.sync(() => events.push("first:end"))),
        ),
    });
    const secondCommand = createRuntimeCommand(runtime, {
      label: "test.second",
      scheduler,
      concurrency,
      execute: () => Effect.sync(() => events.push("second:start")),
    });
    const registry = AtomRegistry.make();

    const first = firstCommand.run(registry, undefined);
    const second = secondCommand.run(registry, undefined);
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    firstLatch.openUnsafe();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    registry.dispose();
  });

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
          scheduleAtomCommandEffect(
            registry,
            scheduler,
            concurrency,
            undefined,
            Effect.sync(() => handoffStarted.openUnsafe()).pipe(
              Effect.andThen(handoffComplete.await),
            ),
          ).pipe(Effect.andThen(resumeComplete.await)),
      });
      const configCommand = createRuntimeCommand(runtime, {
        label: "test.config",
        scheduler,
        concurrency,
        execute: () => Effect.succeed("configured"),
      });
      const registry = AtomRegistry.make();

      const update = updateCommand.run(registry, undefined);
      yield* handoffStarted.await;
      const config = configCommand.run(registry, undefined);
      handoffComplete.openUnsafe();

      expect(yield* Effect.promise(() => config)).toMatchObject({
        _tag: "Success",
        value: "configured",
        waiting: false,
      });
      resumeComplete.openUnsafe();
      expect(yield* Effect.promise(() => update)).toMatchObject({
        _tag: "Success",
        waiting: false,
      });
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
      const runtime = Atom.runtime(Layer.empty);
      const scheduler = createAtomCommandScheduler();
      const concurrency = { mode: "serial" as const, key: () => "shared" };
      const command = createRuntimeCommand(runtime, {
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
            yield* scheduleAtomCommandEffect(
              registry,
              scheduler,
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

      expect(yield* Effect.promise(() => command.run(registry, undefined))).toMatchObject({
        _tag: "Success",
      });
      registry.dispose();
    }),
  );

  it("deduplicates single-flight commands by key", async () => {
    const latch = Latch.makeUnsafe();
    let executions = 0;
    const runtime = Atom.runtime(Layer.empty);
    const command = createRuntimeCommand(runtime, {
      label: "test.single-flight",
      concurrency: { mode: "singleFlight", key: (key: string) => key },
      execute: () =>
        Effect.sync(() => executions++).pipe(Effect.andThen(latch.await), Effect.as("done")),
    });
    const registry = AtomRegistry.make();

    const first = command.run(registry, "same");
    const second = command.run(registry, "same");
    latch.openUnsafe();

    expect(await first).toMatchObject({ _tag: "Success", value: "done", waiting: false });
    expect(await second).toMatchObject({ _tag: "Success", value: "done", waiting: false });
    expect(executions).toBe(1);
    registry.dispose();
  });

  it("coalesces pending latest-value commands without interrupting the active call", async () => {
    const firstLatch = Latch.makeUnsafe();
    const executed: number[] = [];
    const runtime = Atom.runtime(Layer.empty);
    const command = createRuntimeCommand(runtime, {
      label: "test.latest",
      concurrency: { mode: "latest", key: () => "shared" },
      execute: (value: number) =>
        Effect.sync(() => executed.push(value)).pipe(
          Effect.andThen(value === 1 ? firstLatch.await : Effect.void),
          Effect.as(value),
        ),
    });
    const registry = AtomRegistry.make();

    const first = command.run(registry, 1);
    await Promise.resolve();
    const second = command.run(registry, 2);
    const third = command.run(registry, 3);
    firstLatch.openUnsafe();

    expect(await first).toMatchObject({ _tag: "Success", value: 1, waiting: false });
    expect(await second).toMatchObject({ _tag: "Success", value: 3, waiting: false });
    expect(await third).toMatchObject({ _tag: "Success", value: 3, waiting: false });
    expect(executed).toEqual([1, 3]);
    registry.dispose();
  });
});

describe("persisted environment queries", () => {
  it.effect("keeps an in-memory cached page pending until revalidation settles", () =>
    Effect.scoped(
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
    ),
  );

  it.effect(
    "restores cached data in a new registry while offline, then refreshes on reconnect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let saved = Option.none<string>();
          const persistence: QueryPersistence<string> = {
            load: () => Effect.sync(() => saved),
            save: (_environmentId, _key, value) =>
              Effect.sync(() => {
                saved = Option.some(value);
              }),
          };
          const first = yield* makeEnvironmentQueryHarness(Effect.succeed("first"), {
            persistence,
          });
          const firstRegistry = yield* mountEnvironmentQuery(first.atom);
          expect(yield* readEnvironmentQuery(firstRegistry, first.atom)).toBe("first");
          expect(saved).toEqual(Option.some("first"));

          const restarted = yield* makeEnvironmentQueryHarness(Effect.succeed("updated"), {
            persistence,
            initialState: queryConnectionState({ phase: "offline", network: "offline" }),
          });
          const registry = yield* mountEnvironmentQuery(restarted.atom);
          expect(yield* readEnvironmentQuery(registry, restarted.atom)).toBe("first");
          yield* SubscriptionRef.set(restarted.supervisorState, queryConnectionState());
          yield* Effect.yieldNow;
          expect(yield* readEnvironmentQuery(registry, restarted.atom)).toBe("updated");
          expect(saved).toEqual(Option.some("updated"));
        }),
      ),
  );

  it.effect("hands each server answer to onAnswer before readers see it", () =>
    Effect.scoped(
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
    ),
  );

  it.effect("does not hand a value restored from persistence to onAnswer", () =>
    Effect.scoped(
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
    ),
  );

  it.effect("keeps cached content available when revalidation fails", () =>
    Effect.scoped(
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
    ),
  );
});
