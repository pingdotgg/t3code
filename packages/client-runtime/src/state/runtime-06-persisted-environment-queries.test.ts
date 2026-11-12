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

