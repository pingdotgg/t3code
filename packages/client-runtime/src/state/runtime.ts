import type { QueryPersistence } from "./queryPersistence.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { followStreamInEnvironment } from "./environmentStreams.ts";
import { reuseUnchanged } from "./serverConfigProjection.ts";
export { runStreamInEnvironment, followStreamInEnvironment } from "./environmentStreams.ts";
import {
  type ClientGuardedRpcTag,
  EnvironmentId,
  type EnvironmentId as EnvironmentIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { ConnectionAttemptError, SupervisorConnectionState } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  type EnvironmentRpcInput,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcFailure,
  type EnvironmentRpcStreamFailure,
  type EnvironmentRpcStreamValue,
  type EnvironmentSubscriptionRpcTag,
  type EnvironmentUnaryRpcTag,
  EnvironmentRpcUnavailableError,
  request,
  requestGuarded,
  RpcPermissionGuard,
  subscribe,
} from "../rpc/client.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";

const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

/**
 * Holds back the unavailable failure of a query whose session went away. The
 * query atom reruns when it sees that session change, so settling first would
 * show a failure for a query that is about to retry. While `session` is still
 * current no rerun is coming, and the failure stands.
 */
const pendingOnceSessionReplaced =
  (session: RpcSession.RpcSession) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      // The query's error type is generic, so its tags are unknown to `catchTags`.
      Effect.catchIf(isEnvironmentRpcUnavailable, (error) =>
        EnvironmentSupervisor.EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => SubscriptionRef.get(supervisor.session)),
          Effect.flatMap((current) =>
            Option.isSome(current) && current.value === session ? Effect.fail(error) : Effect.never,
          ),
        ),
      ),
    );

interface EnvironmentAtomOptions<Input, A, E, R> {
  readonly label: string;
  readonly execute: (input: Input) => Effect.Effect<A, E, R>;
  readonly scheduler?: AtomCommandScheduler;
  readonly concurrency?: AtomCommandConcurrency<{
    readonly environmentId: EnvironmentIdType;
    readonly input: Input;
  }>;
}

interface EnvironmentCommandAtomOptions<Input, A, E, R> extends Omit<
  EnvironmentAtomOptions<Input, A, E, R>,
  "execute"
> {
  readonly execute: (
    input: Input,
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentIdType,
  ) => Effect.Effect<A, E, R>;
}

interface EnvironmentQueryAtomOptions<Input, A, E, R> extends Omit<
  EnvironmentAtomOptions<Input, A, E, R>,
  "execute"
> {
  /**
   * `emit` shows a provisional value while the query keeps waiting. The settled
   * result replaces it, so catch failures that should keep it on screen.
   */
  readonly execute: (
    input: Input,
    emit: (value: A) => Effect.Effect<void>,
  ) => Effect.Effect<A, E, R>;
  readonly persistence?: QueryPersistence<A>;
  readonly staleTimeMs?: number;
  readonly idleTtlMs?: number;
  readonly refreshIntervalMs?: number;
  readonly refreshTrigger?: (target: {
    readonly environmentId: EnvironmentIdType;
    readonly input: Input;
  }) => Atom.Atom<unknown> | undefined;
  readonly isFinal?: (value: A) => boolean;
  /**
   * Runs where each server answer lands, before readers see it, so derived records (summaries,
   * snapshots, watches) come from the producer instead of from components watching the data.
   * Cached and emitted provisional values are not answers.
   */
  readonly onAnswer?: QueryAnswerHandler<Input, A>;
}

export type QueryAnswerHandler<Input, A> = (
  target: { readonly environmentId: EnvironmentIdType; readonly input: Input },
  value: A,
  registry: AtomRegistry.AtomRegistry,
) => Effect.Effect<void>;

interface EnvironmentSubscriptionAtomOptions<Input, A, E, R> {
  readonly sensitiveInput?: boolean;
  readonly label: string;
  readonly subscribe: (input: Input) => Stream.Stream<A, E, R>;
  readonly completeWhen?: (value: A) => boolean;
  readonly idleTtlMs?: number;
}

export type SettledAsyncResult<A, E> = AsyncResult.Success<A, E> | AsyncResult.Failure<A, E>;

export type AtomCommandResult<A, E> = SettledAsyncResult<A, E>;

export type AtomCommandSuccess<R> = R extends AtomCommandResult<infer A, infer _E> ? A : never;

export type AtomCommandFailure<R> = R extends AtomCommandResult<infer _A, infer E> ? E : never;

export interface AtomCommandOptions {
  readonly label?: string;
  readonly reportFailure?: boolean;
  readonly reportDefect?: boolean;
}

export interface AtomCommandReporter {
  readonly warn: (message: string, cause: Cause.Cause<unknown>) => void;
  readonly error: (message: string, cause: Cause.Cause<unknown>) => void;
}

export interface AtomCommand<W, A, E> {
  readonly label: string;
  readonly run: (registry: AtomRegistry.AtomRegistry, input: W) => Promise<AtomCommandResult<A, E>>;
}

export type AtomCommandConcurrency<W> =
  | { readonly mode: "parallel" }
  | {
      readonly mode: "serial" | "singleFlight" | "latest";
      readonly key: (input: W) => string;
    };

interface AtomCommandSchedulerState {
  readonly serial: Map<string, Promise<unknown>>;
  readonly singleFlight: Map<string, Promise<unknown>>;
  readonly latest: Map<string, AtomCommandLatestLane>;
}

interface AtomCommandLatestBatch {
  execute: () => Promise<AtomCommandResult<unknown, unknown>>;
  readonly resolve: Array<(result: AtomCommandResult<unknown, unknown>) => void>;
}

interface AtomCommandLatestLane {
  running: boolean;
  pending: AtomCommandLatestBatch | undefined;
}

export interface AtomCommandScheduler {
  readonly schedule: <W, A, E>(
    registry: AtomRegistry.AtomRegistry,
    concurrency: AtomCommandConcurrency<W>,
    input: W,
    execute: () => Promise<AtomCommandResult<A, E>>,
  ) => Promise<AtomCommandResult<A, E>>;
}

async function settleAtomCommandResult<A, E>(
  execute: () => Promise<AtomCommandResult<A, E>>,
): Promise<AtomCommandResult<A, E>> {
  try {
    return await execute();
  } catch (defect) {
    return AsyncResult.failure(Cause.die(defect));
  }
}

export function createAtomCommandScheduler(): AtomCommandScheduler {
  const registryStates = new WeakMap<AtomRegistry.AtomRegistry, AtomCommandSchedulerState>();

  const stateFor = (registry: AtomRegistry.AtomRegistry): AtomCommandSchedulerState => {
    const existing = registryStates.get(registry);
    if (existing !== undefined) {
      return existing;
    }
    const state: AtomCommandSchedulerState = {
      serial: new Map(),
      singleFlight: new Map(),
      latest: new Map(),
    };
    registryStates.set(registry, state);
    return state;
  };

  return {
    schedule: <W, A, E>(
      registry: AtomRegistry.AtomRegistry,
      concurrency: AtomCommandConcurrency<W>,
      input: W,
      execute: () => Promise<AtomCommandResult<A, E>>,
    ): Promise<AtomCommandResult<A, E>> => {
      if (concurrency.mode === "parallel") {
        return execute();
      }

      const key = concurrency.key(input);
      const state = stateFor(registry);
      if (concurrency.mode === "singleFlight") {
        const existing = state.singleFlight.get(key) as
          | Promise<AtomCommandResult<A, E>>
          | undefined;
        if (existing !== undefined) {
          return existing;
        }
        const current = execute();
        state.singleFlight.set(key, current);
        void current.then(
          () => {
            if (state.singleFlight.get(key) === current) {
              state.singleFlight.delete(key);
            }
          },
          () => {
            if (state.singleFlight.get(key) === current) {
              state.singleFlight.delete(key);
            }
          },
        );
        return current;
      }

      if (concurrency.mode === "serial") {
        const previous = state.serial.get(key);
        const current = previous === undefined ? execute() : previous.then(execute, execute);
        state.serial.set(key, current);
        void current.then(
          () => {
            if (state.serial.get(key) === current) {
              state.serial.delete(key);
            }
          },
          () => {
            if (state.serial.get(key) === current) {
              state.serial.delete(key);
            }
          },
        );
        return current;
      }

      let lane = state.latest.get(key);
      if (lane === undefined) {
        lane = { running: false, pending: undefined };
        state.latest.set(key, lane);
      }
      const activeLane = lane;

      const result = new Promise<AtomCommandResult<A, E>>((resolve) => {
        if (activeLane.pending === undefined) {
          activeLane.pending = {
            execute: execute as () => Promise<AtomCommandResult<unknown, unknown>>,
            resolve: [resolve as (result: AtomCommandResult<unknown, unknown>) => void],
          };
          return;
        }
        activeLane.pending.execute = execute as () => Promise<AtomCommandResult<unknown, unknown>>;
        activeLane.pending.resolve.push(
          resolve as (result: AtomCommandResult<unknown, unknown>) => void,
        );
      });

      if (!activeLane.running) {
        activeLane.running = true;
        void (async () => {
          while (activeLane.pending !== undefined) {
            const batch = activeLane.pending;
            activeLane.pending = undefined;
            let batchResult: AtomCommandResult<unknown, unknown>;
            try {
              batchResult = await batch.execute();
            } catch (defect) {
              batchResult = AsyncResult.failure(Cause.die(defect));
            }
            for (const resolve of batch.resolve) {
              resolve(batchResult);
            }
          }
          activeLane.running = false;
          if (state.latest.get(key) === activeLane) {
            state.latest.delete(key);
          }
        })();
      }

      return result;
    },
  };
}

export const scheduleAtomCommandEffect =
  /* Every atom command passes through this scheduler; the command owns its tracing boundary. */
  Effect.fnUntraced(function* <W, A, E, R>(
    registry: AtomRegistry.AtomRegistry,
    scheduler: AtomCommandScheduler,
    concurrency: AtomCommandConcurrency<W>,
    input: W,
    effect: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E, R> {
    const context = yield* Effect.context<R>();
    const result = yield* Effect.promise((signal) =>
      scheduler.schedule<W, A, E>(registry, concurrency, input, async () => {
        const exit = await Effect.runPromiseExitWith(context)(effect, { signal });
        return Exit.isSuccess(exit)
          ? AsyncResult.success(exit.value)
          : AsyncResult.failure(exit.cause);
      }),
    );
    return result._tag === "Success" ? result.value : yield* Effect.failCause(result.cause);
  });

export async function runAtomCommand<W, A, E>(
  registry: AtomRegistry.AtomRegistry,
  command: AtomCommand<W, A, E>,
  input: W,
  options: AtomCommandOptions = {},
  reporter: AtomCommandReporter = console,
): Promise<AtomCommandResult<A, E>> {
  const result = await settleAtomCommandResult(() => command.run(registry, input));
  reportAtomCommandResult(result, { ...options, label: options.label ?? command.label }, reporter);
  return result;
}

export function mapAtomCommandResult<A, E, B>(
  result: AtomCommandResult<A, E>,
  map: (value: A) => B,
): AtomCommandResult<B, E> {
  return result._tag === "Success"
    ? AsyncResult.success(map(result.value))
    : AsyncResult.failure(result.cause);
}

export function isAtomCommandInterrupted(result: AtomCommandResult<unknown, unknown>): boolean {
  return result._tag === "Failure" && Cause.hasInterruptsOnly(result.cause);
}

export function squashAtomCommandFailure(result: {
  readonly cause: Cause.Cause<unknown>;
}): unknown {
  return Cause.squash(result.cause);
}

export async function settleAsyncResult<A, E>(
  execute: () => Promise<Exit.Exit<A, E>>,
): Promise<SettledAsyncResult<A, E>> {
  try {
    return AsyncResult.fromExit(await execute());
  } catch (defect) {
    return AsyncResult.failure(Cause.die(defect));
  }
}

async function executeAtomCommand<A, E>(
  execute: () => Promise<Exit.Exit<A, E>>,
  options: AtomCommandOptions = {},
  reporter: AtomCommandReporter = console,
): Promise<AtomCommandResult<A, E>> {
  const result = await settleAsyncResult(execute);
  reportAtomCommandResult(result, options, reporter);
  return result;
}

export interface AtomQueryOptions extends AtomCommandOptions {
  /**
   * Force a fresh execution instead of accepting a value the atom already
   * holds (e.g. an SWR-cached result within its stale window). Used by
   * verification flows where a cached failure must not satisfy a retry.
   */
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
}

export async function executeAtomQuery<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options: AtomQueryOptions = {},
  reporter: AtomCommandReporter = console,
): Promise<AtomCommandResult<A, E>> {
  const query = Effect.scoped(
    Effect.gen(function* () {
      yield* AtomRegistry.mount(registry, atom);
      if (options.refresh) {
        yield* Effect.sync(() => {
          const current = registry.get(atom);
          if (current._tag !== "Initial" && !current.waiting) {
            registry.refresh(atom);
          }
        });
      }
      return yield* AtomRegistry.getResult(registry, atom, {
        suspendOnWaiting: true,
      });
    }),
  );
  return executeAtomCommand(
    () => Effect.runPromiseExit(query, { signal: options.signal }),
    options,
    reporter,
  );
}

export function createRuntimeCommand<R, ER, W, A, E>(
  runtime: Atom.AtomRuntime<R, ER>,
  options: {
    readonly label: string;
    readonly execute: (input: W, registry: AtomRegistry.AtomRegistry) => Effect.Effect<A, E, R>;
    readonly scheduler?: AtomCommandScheduler;
    readonly concurrency?: AtomCommandConcurrency<W>;
  },
): AtomCommand<W, A, E | ER> {
  const scheduler = options.scheduler ?? createAtomCommandScheduler();
  const concurrency = options.concurrency ?? { mode: "parallel" as const };
  return {
    label: options.label,
    run: (registry, input) =>
      settleAtomCommandResult(() =>
        scheduler.schedule(registry, concurrency, input, () => {
          const atom = runtime
            .atom(options.execute(input, registry))
            .pipe(Atom.withLabel(options.label));
          return executeAtomQuery(registry, atom, { reportDefect: false, reportFailure: false });
        }),
      ),
  };
}

export function reportAtomCommandResult(
  result: AtomCommandResult<unknown, unknown>,
  options: AtomCommandOptions = {},
  reporter: AtomCommandReporter = console,
): void {
  if (AsyncResult.isSuccess(result) || Cause.hasInterruptsOnly(result.cause)) {
    return;
  }

  const label = options.label ?? "atom command";
  if (Cause.hasDies(result.cause)) {
    if (options.reportDefect ?? true) {
      reporter.error(`[atom-command] ${label} defected`, result.cause);
    }
  } else if (options.reportFailure ?? true) {
    reporter.warn(`[atom-command] ${label} failed`, result.cause);
  }
}

export async function settlePromise<A>(
  execute: () => Promise<A>,
): Promise<AtomCommandResult<A, never>> {
  try {
    return AsyncResult.success(await execute());
  } catch (defect) {
    return AsyncResult.failure(Cause.die(defect));
  }
}

function environmentRpcKey<Input>(target: {
  readonly environmentId: EnvironmentIdType;
  readonly input: Input;
}): string {
  return JSON.stringify([target.environmentId, target.input]);
}

function parseEnvironmentRpcKey<Input>(key: string): {
  readonly environmentId: EnvironmentIdType;
  readonly input: Input;
} {
  const decoded = JSON.parse(key) as [EnvironmentIdType, Input];
  return {
    environmentId: EnvironmentId.make(decoded[0]),
    input: decoded[1],
  };
}

function runInEnvironment<A, E, R>(
  environmentId: EnvironmentIdType,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | EnvironmentRegistry.EnvironmentNotRegisteredError,
  EnvironmentRegistry.EnvironmentRegistry | Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
> {
  return EnvironmentRegistry.EnvironmentRegistry.pipe(
    Effect.flatMap((registry) => registry.run(environmentId, effect)),
  );
}

/**
 * `Atom.makeRefreshOnSignal` subscribes to the signal, so a query that outlives its view on an
 * idle TTL still re-runs on every change. Reading the signal as a dependency instead lets the
 * registry re-run a mounted query right away and only mark an idle one stale, which then
 * refreshes on its next read.
 */
const refreshOnSignalWhileRead =
  <V>(signal: Atom.Atom<unknown>, isFinal: (value: V) => boolean) =>
  <A extends V>(self: Atom.Atom<A>): Atom.Atom<A> => {
    // The signal value each registry's data was read under. Held outside the node because the
    // registry can sweep this node while `self` keeps the data, and the rebuilt node must still
    // see a change it missed.
    const readUnder = new WeakMap<AtomRegistry.AtomRegistry, unknown>();
    return Atom.transform(
      self,
      (get) => {
        const current = get(signal);
        get.subscribe(self, (value) => get.setSelf(value));
        const changed =
          readUnder.has(get.registry) && !Object.is(readUnder.get(get.registry), current);
        readUnder.set(get.registry, current);
        if (changed && !isFinal(get.once(self))) get.refresh(self);
        return get.once(self);
      },
      { initialValueTarget: self },
    );
  };

const refreshEveryUntilFinal =
  <V>(intervalMs: number, isFinal: (value: V) => boolean) =>
  <A extends V>(self: Atom.Atom<A>): Atom.Atom<A> =>
    Atom.transform(
      self,
      (get) => {
        const value = get(self);
        if (!isFinal(value)) {
          // @effect-diagnostics-next-line globalTimers:off - Mirrors `Atom.withRefresh`, outside an Effect runtime.
          const handle = setTimeout(() => get.refresh(self), intervalMs);
          get.addFinalizer(() => clearTimeout(handle));
        }
        return value;
      },
      { initialValueTarget: self },
    );

/**
 * A query result's data alone. A refetch always publishes a new result (a new
 * timestamp, `waiting` on and off), while equal data keeps its identity, so a
 * reader of only this skips the refetches that changed nothing.
 */
export const selectEnvironmentQueryData = <A, E>(result: AsyncResult.AsyncResult<A, E>): A | null =>
  AsyncResult.getOrElse(result, () => null);

type EnvironmentConnection = readonly [
  SupervisorConnectionState,
  Option.Option<RpcSession.RpcSession>,
];

const connectionAtomsByRuntime = new WeakMap<
  object,
  (
    environmentId: EnvironmentIdType,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentConnection | null>>
>();

/**
 * One connection atom per environment for every query on a runtime, so a reader of the session
 * generation and a query it re-runs see the same connection change at once.
 */
function environmentConnectionAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  const existing = connectionAtomsByRuntime.get(runtime);
  if (existing !== undefined) return existing;
  const family = Atom.family((environmentId: EnvironmentIdType) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.state).pipe(
                Stream.zipLatest(SubscriptionRef.changes(supervisor.session)),
              ),
            ),
          ),
        ),
      ),
      { initialValue: null },
    ),
  ) as (
    environmentId: EnvironmentIdType,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentConnection | null>>;
  connectionAtomsByRuntime.set(runtime, family);
  return family;
}

const sessionGenerationAtomsByRuntime = new WeakMap<
  object,
  (environmentId: EnvironmentIdType) => Atom.Atom<number>
>();

/**
 * Counts established sessions; it changes only when a new one comes up, so failed one-shot reads
 * can watch it to run again. Keyed on the session object because the supervisor's `generation`
 * restarts when the registry installs a new supervisor (re-pairing, route edits).
 */
export function environmentSessionGenerationAtom<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  environmentId: EnvironmentIdType,
): Atom.Atom<number> {
  let family = sessionGenerationAtomsByRuntime.get(runtime);
  if (family === undefined) {
    const connectionAtom = environmentConnectionAtoms(runtime);
    const sessionsSeen = Atom.family((id: EnvironmentIdType) =>
      Atom.make(
        (get): { readonly session: RpcSession.RpcSession | null; readonly count: number } => {
          const previous = Option.getOrElse(
            get.self<{ readonly session: RpcSession.RpcSession | null; readonly count: number }>(),
            () => ({ session: null, count: 0 }),
          );
          const connection = AsyncResult.getOrElse(get(connectionAtom(id)), () => null);
          if (connection === null || connection[0].phase !== "connected") return previous;
          const session = Option.getOrNull(connection[1]);
          return session === null || session === previous.session
            ? previous
            : { session, count: previous.count + 1 };
        },
      ),
    );
    family = Atom.family((id: EnvironmentIdType) =>
      Atom.make((get) => get(sessionsSeen(id)).count).pipe(
        Atom.withLabel(`environment-session-generation:${id}`),
      ),
    );
    sessionGenerationAtomsByRuntime.set(runtime, family);
  }
  return family(environmentId);
}

export function createEnvironmentQueryAtomFamily<R, ER, Input, A, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: EnvironmentQueryAtomOptions<
    Input,
    A,
    E,
    | EnvironmentSupervisor.EnvironmentSupervisor
    | EnvironmentRegistry.EnvironmentRegistry
    | AtomRegistry.AtomRegistry
    | R
  >,
): (target: {
  readonly environmentId: EnvironmentIdType;
  readonly input: Input;
}) => Atom.Atom<AsyncResult.AsyncResult<A, E | ER | Error>> {
  const connectionAtom = environmentConnectionAtoms(runtime);
  const family = Atom.family((key: string) => {
    const target = parseEnvironmentRpcKey<Input>(key);
    const idleTtlMs = options.idleTtlMs ?? 5 * 60_000;
    const queryAtom = runtime
      .atom<
        A,
        | E
        | ConnectionAttemptError
        | EnvironmentRegistry.EnvironmentNotRegisteredError
        | EnvironmentRpcUnavailableError
      >((get) => {
        const connection = AsyncResult.getOrElse(
          get(connectionAtom(target.environmentId)),
          () => null,
        );
        // A refetch that returns equal content keeps the previous value's
        // references, so readers of the data skip re-rendering on idle polls.
        const share = (value: A): A =>
          reuseUnchanged(
            Option.getOrUndefined(
              Option.flatMap(get.self<AsyncResult.AsyncResult<A, unknown>>(), AsyncResult.value),
            ),
            value,
          );
        const emit = (value: A) =>
          Effect.sync(() => get.setSelf(AsyncResult.success(share(value), { waiting: true }))).pipe(
            // A value set while the atom builds wins over the build's own
            // result, so a query that then settled synchronously would stay
            // waiting forever. Suspend on a promise (`yieldNow` is drained
            // inside the build) so the settled result arrives asynchronously.
            Effect.andThen(Effect.promise(() => Promise.resolve())),
          );
        const execute = (): Effect.Effect<
          A,
          | E
          | ConnectionAttemptError
          | EnvironmentRegistry.EnvironmentNotRegisteredError
          | EnvironmentRpcUnavailableError,
          | EnvironmentRegistry.EnvironmentRegistry
          | AtomRegistry.AtomRegistry
          | Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
        > => {
          if (connection === null) return Effect.never;
          const [connectionState, session] = connection;
          switch (connectionState.phase) {
            case "connected":
              return Option.isSome(session)
                ? runInEnvironment(
                    target.environmentId,
                    options
                      .execute(target.input, emit)
                      .pipe(pendingOnceSessionReplaced(session.value)),
                  )
                : Effect.never;
            case "connecting":
            case "backoff":
              // A retry can take minutes. A query with an answer keeps showing it while it
              // waits; one with nothing to show reports the failure the retry is recovering
              // from, so its reader stops loading, and re-runs when the connection settles.
              return connectionState.lastFailure !== null &&
                Option.isNone(
                  Option.flatMap(
                    get.self<AsyncResult.AsyncResult<A, unknown>>(),
                    AsyncResult.value,
                  ),
                )
                ? Effect.fail(connectionState.lastFailure)
                : Effect.never;
            case "available":
            case "offline":
            case "blocked":
              if (connectionState.lastFailure !== null) {
                return Effect.fail(connectionState.lastFailure);
              }
              return Effect.fail(
                new EnvironmentRpcUnavailableError({
                  environmentId: target.environmentId,
                  message: `Environment ${target.environmentId} is ${
                    connectionState.phase === "available" ? "not connected" : connectionState.phase
                  }.`,
                }),
              );
          }
        };
        const onAnswer = options.onAnswer;
        const answer = () =>
          onAnswer === undefined
            ? execute().pipe(Effect.map(share))
            : execute().pipe(
                Effect.map(share),
                Effect.tap((value) => onAnswer(target, value, get.registry)),
              );
        if (!options.persistence) return answer();
        const persistence = options.persistence;
        const cacheKey = JSON.stringify([options.label, target.input]);
        const previous = Option.flatMap(
          get.self<AsyncResult.AsyncResult<A, unknown>>(),
          AsyncResult.value,
        );
        return Effect.gen(function* () {
          const cached = Option.isSome(previous)
            ? previous
            : yield* persistence.load(target.environmentId, cacheKey);
          if (
            Option.isSome(cached) &&
            (connection === null || connection[0].phase !== "connected")
          ) {
            return cached.value;
          }
          if (Option.isNone(previous) && Option.isSome(cached)) yield* emit(cached.value);
          return yield* answer().pipe(
            Effect.tap((value) => persistence.save(target.environmentId, cacheKey, value)),
          );
        });
      })
      .pipe(
        Atom.swr({
          staleTime: options.staleTimeMs ?? 30_000,
          revalidateOnMount: true,
        }),
        Atom.setIdleTTL(idleTtlMs),
      );
    const isFinal = (result: AsyncResult.AsyncResult<A, unknown>) =>
      options.isFinal !== undefined && Option.exists(AsyncResult.value(result), options.isFinal);
    const intervalQuery =
      options.refreshIntervalMs === undefined
        ? queryAtom
        : queryAtom.pipe(refreshEveryUntilFinal(options.refreshIntervalMs, isFinal));
    const refreshTrigger = options.refreshTrigger?.(target);
    return (
      refreshTrigger === undefined
        ? intervalQuery
        : intervalQuery.pipe(refreshOnSignalWhileRead(refreshTrigger, isFinal))
    ).pipe(Atom.setIdleTTL(idleTtlMs), Atom.withLabel(`${options.label}:${key}`));
  });
  return (target) => family(environmentRpcKey(target));
}

export function createEnvironmentSubscriptionAtomFamily<R, ER, Input, A, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: EnvironmentSubscriptionAtomOptions<
    Input,
    A,
    E,
    EnvironmentSupervisor.EnvironmentSupervisor | R
  >,
) {
  const family = Atom.family((key: string) => {
    const target = parseEnvironmentRpcKey<Input>(key);
    return runtime
      .atom(
        Stream.suspend(() =>
          followStreamInEnvironment(target.environmentId, options.subscribe(target.input)),
        ).pipe(options.completeWhen ? Stream.takeUntil(options.completeWhen) : (stream) => stream),
      )
      .pipe(
        Atom.setIdleTTL(options.idleTtlMs ?? 5 * 60_000),
        Atom.withLabel(
          options.sensitiveInput
            ? `${options.label}:${target.environmentId}`
            : `${options.label}:${key}`,
        ),
      );
  });
  return (target: { readonly environmentId: EnvironmentIdType; readonly input: Input }) =>
    family(environmentRpcKey(target));
}

export function createEnvironmentCommand<R, ER, Input, A, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: EnvironmentCommandAtomOptions<
    Input,
    A,
    E,
    EnvironmentSupervisor.EnvironmentSupervisor | EnvironmentRegistry.EnvironmentRegistry | R
  >,
) {
  return createRuntimeCommand(runtime, {
    label: options.label,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    execute: (target, registry) =>
      runInEnvironment(
        target.environmentId,
        options.execute(target.input, registry, target.environmentId),
      ),
  });
}

export function createEnvironmentRpcQueryAtomFamily<
  R,
  ER,
  TTag extends Exclude<EnvironmentUnaryRpcTag, ClientGuardedRpcTag>,
>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: {
    readonly label: string;
    readonly tag: TTag;
    readonly execute?: (
      input: EnvironmentRpcInput<TTag>,
      emit: (value: EnvironmentRpcSuccess<TTag>) => Effect.Effect<void>,
    ) => Effect.Effect<
      EnvironmentRpcSuccess<TTag>,
      EnvironmentRpcFailure<TTag> | EnvironmentRpcUnavailableError,
      EnvironmentSupervisor.EnvironmentSupervisor | EnvironmentRegistry.EnvironmentRegistry
    >;
    readonly persistence?: QueryPersistence<EnvironmentRpcSuccess<TTag>>;
    readonly staleTimeMs?: number;
    readonly idleTtlMs?: number;
    readonly refreshIntervalMs?: number;
    readonly refreshTrigger?: (target: {
      readonly environmentId: EnvironmentIdType;
      readonly input: EnvironmentRpcInput<TTag>;
    }) => Atom.Atom<unknown> | undefined;
    readonly isFinal?: (value: EnvironmentRpcSuccess<TTag>) => boolean;
    readonly onAnswer?: QueryAnswerHandler<EnvironmentRpcInput<TTag>, EnvironmentRpcSuccess<TTag>>;
  },
) {
  return createEnvironmentQueryAtomFamily(runtime, {
    label: options.label,
    ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
    ...(options.staleTimeMs === undefined ? {} : { staleTimeMs: options.staleTimeMs }),
    ...(options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs }),
    ...(options.refreshIntervalMs === undefined
      ? {}
      : { refreshIntervalMs: options.refreshIntervalMs }),
    ...(options.refreshTrigger === undefined ? {} : { refreshTrigger: options.refreshTrigger }),
    ...(options.isFinal === undefined ? {} : { isFinal: options.isFinal }),
    ...(options.onAnswer === undefined ? {} : { onAnswer: options.onAnswer }),
    execute: (
      input: EnvironmentRpcInput<TTag>,
      emit: (value: EnvironmentRpcSuccess<TTag>) => Effect.Effect<void>,
    ) => options.execute?.(input, emit) ?? request(options.tag, input),
  });
}

export function createEnvironmentRpcSubscriptionAtomFamily<
  R,
  ER,
  TTag extends EnvironmentSubscriptionRpcTag,
  B = EnvironmentRpcStreamValue<TTag>,
>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: {
    readonly label: string;
    readonly tag: TTag;
    readonly idleTtlMs?: number;
    readonly completeWhen?: (value: B) => boolean;
    readonly transform?: (
      stream: Stream.Stream<
        EnvironmentRpcStreamValue<TTag>,
        EnvironmentRpcStreamFailure<TTag>,
        EnvironmentSupervisor.EnvironmentSupervisor | R
      >,
    ) => Stream.Stream<
      B,
      EnvironmentRpcStreamFailure<TTag>,
      EnvironmentSupervisor.EnvironmentSupervisor | R
    >;
  },
) {
  return createEnvironmentSubscriptionAtomFamily(runtime, {
    label: options.label,
    ...(options.completeWhen === undefined ? {} : { completeWhen: options.completeWhen }),
    ...(options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs }),
    subscribe: (input: EnvironmentRpcInput<TTag>) => {
      const stream = subscribe(options.tag, input);
      return options.transform === undefined
        ? (stream as Stream.Stream<
            B,
            EnvironmentRpcStreamFailure<TTag>,
            EnvironmentSupervisor.EnvironmentSupervisor | R
          >)
        : options.transform(stream);
    },
  });
}

export function createEnvironmentRpcCommand<
  R,
  ER,
  TTag extends EnvironmentUnaryRpcTag,
  Input extends EnvironmentRpcInput<TTag> = EnvironmentRpcInput<TTag>,
>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: {
    readonly label: string;
    readonly tag: TTag;
    readonly execute?: (
      input: Input,
    ) => Effect.Effect<
      EnvironmentRpcSuccess<TTag>,
      EnvironmentRpcFailure<TTag> | EnvironmentRpcUnavailableError,
      EnvironmentSupervisor.EnvironmentSupervisor | EnvironmentRegistry.EnvironmentRegistry
    >;
    readonly scheduler?: AtomCommandScheduler;
    readonly concurrency?: AtomCommandConcurrency<{
      readonly environmentId: EnvironmentIdType;
      readonly input: NoInfer<Input>;
    }>;
    readonly onSuccess?: (
      target: {
        readonly environmentId: EnvironmentIdType;
        readonly input: NoInfer<Input>;
      },
      registry: AtomRegistry.AtomRegistry,
      result: EnvironmentRpcSuccess<TTag>,
    ) => Effect.Effect<void, never, R>;
    readonly onSettled?: (
      target: {
        readonly environmentId: EnvironmentIdType;
        readonly input: NoInfer<Input>;
      },
      registry: AtomRegistry.AtomRegistry,
    ) => Effect.Effect<void, never, R>;
  },
) {
  const permissions = createCommandPermissions(runtime, options.tag);
  const command = createEnvironmentCommand(runtime, {
    label: options.label,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    execute: (input: Input, registry, environmentId) => {
      const target = {
        environmentId,
        input,
      };
      // Routing requires consent on the origin as well as the actual destination.
      // The transport check below deliberately checks the destination again.
      return permissions.authorize(registry, environmentId, input).pipe(
        Effect.andThen(() => options.execute?.(input) ?? requestGuarded(options.tag, input)),
        Effect.provideService(RpcPermissionGuard, {
          authorize: (id, method, payload) =>
            createCommandPermissions(runtime, method).authorize(registry, id, payload),
        }),
        Effect.tap((result) => options.onSuccess?.(target, registry, result) ?? Effect.void),
        Effect.ensuring(options.onSettled?.(target, registry) ?? Effect.void),
      );
    },
  });
  return {
    ...command,
    requiredScopes: permissions.requiredScopes,
    permissionAtom: permissions.permissionAtom,
  };
}
