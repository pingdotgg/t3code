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

