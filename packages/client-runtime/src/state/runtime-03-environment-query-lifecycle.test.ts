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

