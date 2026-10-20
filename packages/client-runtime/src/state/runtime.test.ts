import { describe, expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
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
import type { QueryPersistence } from "./queryPersistence.ts";
import { createTerminalEnvironmentAtoms } from "./terminal.ts";
import {
  environmentRpcKey,
  createAtomCommandScheduler,
  createEnvironmentQueryAtomFamily,
  selectEnvironmentQueryData,
  createEnvironmentSubscriptionAtomFamily,
  createRuntimeCommand,
  scheduleAtomCommandEffect,
  executeAtomCommand,
  executeAtomQuery,
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
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
    isFinal,
  }: {
    readonly refreshTrigger?: Atom.Atom<unknown>;
    readonly isFinal?: (value: A) => boolean;
    readonly idleTtlMs?: number;
    readonly persistence?: QueryPersistence<A>;
    readonly initialState?: SupervisorConnectionState;
  } = {},
) {
  const supervisorState = yield* SubscriptionRef.make(initialState ?? queryConnectionState());
  const supervisorSession = yield* SubscriptionRef.make(Option.some(QUERY_RPC_SESSION));
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

describe("settleAsyncResult", () => {
  it("preserves successful values and typed failures", async () => {
    const success = await settleAsyncResult(() => Promise.resolve(Exit.succeed("done")));
    expect(AsyncResult.isSuccess(success)).toBe(true);
    if (AsyncResult.isSuccess(success)) {
      expect(success.value).toBe("done");
    }

    const expectedFailure = new Error("request failed");
    const failure = await settleAsyncResult(() => Promise.resolve(Exit.fail(expectedFailure)));
    expect(AsyncResult.isFailure(failure)).toBe(true);
    if (AsyncResult.isFailure(failure)) {
      expect(Cause.hasDies(failure.cause)).toBe(false);
      expect(Cause.squash(failure.cause)).toBe(expectedFailure);
    }
  });

  it("encodes thrown and rejected promises as defects", async () => {
    const thrownDefect = new Error("thrown defect");
    const thrown = await settleAsyncResult<void, never>(() => {
      throw thrownDefect;
    });
    expect(AsyncResult.isFailure(thrown)).toBe(true);
    if (AsyncResult.isFailure(thrown)) {
      expect(Cause.hasDies(thrown.cause)).toBe(true);
      expect(Cause.squash(thrown.cause)).toBe(thrownDefect);
    }

    const rejectedDefect = new Error("rejected defect");
    const rejected = await settleAsyncResult<void, never>(() => Promise.reject(rejectedDefect));
    expect(AsyncResult.isFailure(rejected)).toBe(true);
    if (AsyncResult.isFailure(rejected)) {
      expect(Cause.hasDies(rejected.cause)).toBe(true);
      expect(Cause.squash(rejected.cause)).toBe(rejectedDefect);
    }
  });
});

describe("atom command result helpers", () => {
  it("maps successful command values", () => {
    const result = mapAtomCommandResult(AsyncResult.success(2), (value) => value * 3);

    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.value).toBe(6);
    }
  });

  it("preserves failures while mapping", () => {
    const result = mapAtomCommandResult(
      AsyncResult.failure<number, string>(Cause.fail("nope")),
      (value) => value * 3,
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.squash(result.cause)).toBe("nope");
    }
  });

  it("distinguishes interruption from other failures", () => {
    const interrupted = AsyncResult.failure(Cause.interrupt(1));
    const failed = AsyncResult.failure(Cause.fail("nope"));

    expect(isAtomCommandInterrupted(interrupted)).toBe(true);
    expect(isAtomCommandInterrupted(failed)).toBe(false);
    expect(squashAtomCommandFailure(failed)).toBe("nope");
  });

  it("settles raw promise boundaries as successes or defects", async () => {
    const success = await settlePromise(() => Promise.resolve("done"));
    expect(success._tag).toBe("Success");

    const defect = new Error("raw promise rejected");
    const failure = await settlePromise(() => Promise.reject(defect));
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect(Cause.hasDies(failure.cause)).toBe(true);
      expect(Cause.squash(failure.cause)).toBe(defect);
    }
  });

  it("reports expected failures and defects through separate policies", async () => {
    const warnings: string[] = [];
    const errors: string[] = [];
    const reporter = {
      warn: (message: string) => {
        warnings.push(message);
      },
      error: (message: string) => {
        errors.push(message);
      },
    };

    await executeAtomCommand(() => Promise.resolve(Exit.fail("nope")), { label: "save" }, reporter);
    await executeAtomCommand(
      () => Promise.resolve(Exit.fail("ignored")),
      { label: "quiet save", reportFailure: false },
      reporter,
    );
    await executeAtomCommand(
      () => Promise.reject(new Error("defect")),
      { label: "quiet save", reportFailure: false },
      reporter,
    );
    await executeAtomCommand(
      () => Promise.resolve(Exit.interrupt(1)),
      { label: "interrupted" },
      reporter,
    );

    expect(warnings).toEqual(["[atom-command] save failed"]);
    expect(errors).toEqual(["[atom-command] quiet save defected"]);
  });
});

describe("environmentRpcKey", () => {
  it("isolates subscription state by environment and cwd", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const originalTarget = {
      environmentId,
      input: { cwd: "/repo/original" },
    };
    const nextTarget = {
      environmentId,
      input: { cwd: "/repo/next" },
    };

    expect(environmentRpcKey(originalTarget)).not.toBe(environmentRpcKey(nextTarget));
    expect(environmentRpcKey(originalTarget)).toBe(environmentRpcKey({ ...originalTarget }));
    expect(
      environmentRpcKey({
        environmentId: EnvironmentId.make("environment-2"),
        input: originalTarget.input,
      }),
    ).not.toBe(environmentRpcKey(originalTarget));
  });
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

  it.effect("keeps the previous value when a refetch returns equal content", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let checks = [{ name: "ci", status: "passed" }];
        const execute = Effect.sync(() => ({ checks: checks.map((check) => ({ ...check })) }));
        const harness = yield* makeEnvironmentQueryHarness(execute);
        const registry = yield* mountEnvironmentQuery(harness.atom);

        const first = yield* readEnvironmentQuery(registry, harness.atom);
        registry.refresh(harness.atom);
        const equal = yield* readEnvironmentQuery(registry, harness.atom);
        expect(equal).toBe(first);

        checks = [{ name: "ci", status: "failed" }];
        registry.refresh(harness.atom);
        const changed = yield* readEnvironmentQuery(registry, harness.atom);
        expect(changed).not.toBe(first);
        expect(changed.checks[0]?.status).toBe("failed");
      }),
    ),
  );

  it.effect("does not notify a data-only reader when a refetch returns equal content", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let status = "passed";
        const execute = Effect.sync(() => ({ checks: [{ name: "ci", status }] }));
        const harness = yield* makeEnvironmentQueryHarness(execute);
        const registry = yield* mountEnvironmentQuery(harness.atom);
        yield* readEnvironmentQuery(registry, harness.atom);

        const data = Atom.map(harness.atom, selectEnvironmentQueryData);
        const seen: Array<unknown> = [];
        let resultNotifications = 0;
        const unsubscribeData = registry.subscribe(data, (value) => seen.push(value), {
          immediate: true,
        });
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeData));
        const unsubscribeResult = registry.subscribe(harness.atom, () => resultNotifications++);
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeResult));

        registry.refresh(harness.atom);
        yield* readEnvironmentQuery(registry, harness.atom);
        // The result itself still moves (timestamp, `waiting`), which SWR relies on.
        expect(resultNotifications).toBeGreaterThan(0);
        expect(seen).toHaveLength(1);

        status = "failed";
        registry.refresh(harness.atom);
        yield* readEnvironmentQuery(registry, harness.atom);
        expect(seen).toHaveLength(2);
        expect(seen[1]).toEqual({ checks: [{ name: "ci", status: "failed" }] });
      }),
    ),
  );

  it.effect(
    "retries an interrupted query without exposing a failure during session replacement",
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
          yield* SubscriptionRef.set(
            harness.supervisorState,
            queryConnectionState({
              phase: "backoff",
              stage: null,
              lastFailure: new ConnectionTransientError({
                reason: "transport",
                detail: "Relay session is reconnecting.",
              }),
              retryAt: 1,
            }),
          );
          yield* Effect.yieldNow;

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

  it.effect("stops refreshing on its trigger once the value is final", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let executions = 0;
        const trigger = Atom.make(0).pipe(Atom.keepAlive);
        const harness = yield* makeEnvironmentQueryHarness(
          Effect.sync(() => (executions += 1)),
          { refreshTrigger: trigger, isFinal: (value) => value >= 2 },
        );
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const read = readEnvironmentQuery(registry, harness.atom);

        registry.mount(harness.atom);
        expect(yield* read).toBe(1);
        registry.set(trigger, 1);
        expect(yield* read).toBe(2);
        registry.set(trigger, 2);
        expect(yield* read).toBe(2);
        expect(executions).toBe(2);
      }),
    ),
  );

  it.effect("keeps an idle query when its trigger recomputes to the same value", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let executions = 0;
        const settings = Atom.make({ theme: "dark" }).pipe(Atom.keepAlive);
        const trigger = Atom.make((get) => JSON.stringify([get(settings) !== null]));
        const harness = yield* makeEnvironmentQueryHarness(
          Effect.sync(() => (executions += 1)),
          { refreshTrigger: trigger },
        );
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const read = readEnvironmentQuery(registry, harness.atom);

        const unmount = registry.mount(harness.atom);
        expect(yield* read).toBe(1);
        unmount();
        registry.set(settings, { theme: "light" });
        expect(yield* read).toBe(1);
        expect(executions).toBe(1);
      }),
    ),
  );

  it.effect("refreshes an idle query the registry swept and rebuilt after its trigger moved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        let executions = 0;
        const trigger = Atom.make(0).pipe(Atom.keepAlive);
        const harness = yield* makeEnvironmentQueryHarness(
          Effect.sync(() => (executions += 1)),
          { refreshTrigger: trigger, idleTtlMs: 1_000 },
        );
        const registry = AtomRegistry.make({ timeoutResolution: 100 });
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const read = readEnvironmentQuery(registry, harness.atom);

        const unmount = registry.mount(harness.atom);
        expect(yield* read).toBe(1);
        unmount();
        yield* Effect.yieldNow;
        vi.advanceTimersByTime(500);
        registry.set(trigger, 1);
        yield* Effect.yieldNow;
        vi.advanceTimersByTime(700);
        expect(executions).toBe(1);

        expect(yield* read).toBe(2);
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
  it("encodes custom command rejections as defects", async () => {
    const defect = new Error("custom command rejected");
    const registry = AtomRegistry.make();
    const result = await runAtomCommand(
      registry,
      {
        label: "test.rejected-command",
        run: () => Promise.reject(defect),
      },
      undefined,
      { reportDefect: false },
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.hasDies(result.cause)).toBe(true);
      expect(Cause.squash(result.cause)).toBe(defect);
    }
    registry.dispose();
  });

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

  it("correlates parallel invocation results", async () => {
    const firstLatch = Latch.makeUnsafe();
    const secondLatch = Latch.makeUnsafe();
    const runtime = Atom.runtime(Layer.empty);
    const command = createRuntimeCommand(runtime, {
      label: "test.parallel",
      execute: (id: "first" | "second") =>
        (id === "first" ? firstLatch : secondLatch).await.pipe(Effect.as(id)),
    });
    const registry = AtomRegistry.make();

    const first = command.run(registry, "first");
    const second = command.run(registry, "second");
    secondLatch.openUnsafe();
    firstLatch.openUnsafe();

    expect(await first).toMatchObject({ _tag: "Success", value: "first", waiting: false });
    expect(await second).toMatchObject({ _tag: "Success", value: "second", waiting: false });
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
        expect(Option.getOrNull(AsyncResult.value(registry.get(harness.atom)))).toBe("cached");
      }),
    ),
  );

  it.effect("shows persisted data before a live request finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* Deferred.make<string>();
        const seeded = yield* Deferred.make<void>();
        const refreshed = yield* Deferred.make<void>();
        const harness = yield* makeEnvironmentQueryHarness(Deferred.await(response), {
          persistence: {
            load: () => Effect.succeedSome("cached"),
            save: () => Effect.void,
          },
        });
        const registry = yield* mountEnvironmentQuery(harness.atom);
        const unsubscribe = registry.subscribe(
          harness.atom,
          (value) => {
            if (Option.getOrNull(AsyncResult.value(value)) === "cached")
              Deferred.doneUnsafe(seeded, Exit.void);
            if (Option.getOrNull(AsyncResult.value(value)) === "fresh")
              Deferred.doneUnsafe(refreshed, Exit.void);
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        yield* Deferred.await(seeded);
        expect(Option.getOrNull(AsyncResult.value(registry.get(harness.atom)))).toBe("cached");
        yield* Deferred.succeed(response, "fresh");
        yield* Deferred.await(refreshed);
        expect(yield* readEnvironmentQuery(registry, harness.atom)).toBe("fresh");
      }),
    ),
  );
});
