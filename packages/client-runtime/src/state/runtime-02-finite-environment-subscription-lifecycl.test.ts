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

