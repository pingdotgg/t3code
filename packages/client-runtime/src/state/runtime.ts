import { msg } from "gt-i18n";
import { translatableMessage } from "../errors/translatable.ts";
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
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
    previous: Option.Option<A>,
  ) => Effect.Effect<A, E, R>;
  readonly persistence?: QueryPersistence<A>;
  readonly staleTimeMs?: number;
  readonly idleTtlMs?: number;
  readonly refreshIntervalMs?: number;
  /** Each change of the returned signal refreshes the query; `query` is the data it refreshes. */
  readonly refreshTrigger?: (
    target: {
      readonly environmentId: EnvironmentIdType;
      readonly input: Input;
    },
    query: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  ) => Atom.Atom<unknown> | undefined;
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
  /** Keeps a completed value this long after its last reader leaves, so reopening skips a resubscribe. */
  readonly completedTtlMs?: number;
}

export type SettledAsyncResult<A, E> = AsyncResult.Success<A, E> | AsyncResult.Failure<A, E>;

export type AtomCommandResult<A, E> = SettledAsyncResult<A, E>;

export type AtomCommandSuccess<R> = R extends AtomCommandResult<infer A, infer _E> ? A : never;

export type AtomCommandFailure<R> = R extends AtomCommandResult<infer _A, infer E> ? E : never;

export interface AtomCommandOptions {
  readonly label?: string;
  readonly reportFailure?: boolean;
  readonly reportDefect?: boolean;
  /** Aborting interrupts the run. */
  readonly signal?: AbortSignal | undefined;
}

export interface AtomCommandReporter {
  readonly warn: (message: string, cause: Cause.Cause<unknown>) => void;
  readonly error: (message: string, cause: Cause.Cause<unknown>) => void;
}

export interface AtomCommand<W, A, E> {
  readonly label: string;
  /**
   * Runs on the calling fiber, so interrupting the caller stops the command. Code outside
   * Effect starts it with `runAtomCommand`.
   */
  readonly run: (registry: AtomRegistry.AtomRegistry, input: W) => Effect.Effect<A, E>;
}

export type AtomCommandConcurrency<W> =
  | { readonly mode: "parallel" }
  | {
      readonly mode: "serial" | "singleFlight" | "latest";
      readonly key: (input: W) => string;
    };

/** One run that several callers wait on. It is interrupted once the last of them stops waiting. */
interface SharedRun {
  readonly result: Deferred.Deferred<unknown, unknown>;
  waiters: number;
  fiber: Fiber.Fiber<unknown, unknown> | undefined;
}

interface AtomCommandLatestLane {
  pending: (SharedRun & { start: Effect.Effect<void> }) | undefined;
}

interface AtomCommandSchedulerState {
  readonly serial: Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>;
  readonly singleFlight: Map<string, SharedRun>;
  readonly latest: Map<string, AtomCommandLatestLane>;
}

export interface AtomCommandScheduler {
  readonly schedule: <W, A, E, R>(
    registry: AtomRegistry.AtomRegistry,
    concurrency: AtomCommandConcurrency<W>,
    input: W,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

const startSharedRun = <A, E>(run: SharedRun, effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.interruptible,
    Effect.onExit((exit) => Deferred.done(run.result, exit)),
    Effect.ignoreCause,
    Effect.forkDetach({ startImmediately: true }),
    Effect.map((fiber) => {
      run.fiber = fiber;
    }),
  );

const awaitSharedRun = <A, E>(
  run: SharedRun,
  restore: <X, XE, XR>(effect: Effect.Effect<X, XE, XR>) => Effect.Effect<X, XE, XR>,
  abandon: Effect.Effect<void>,
): Effect.Effect<A, E> => {
  run.waiters++;
  return restore(Deferred.await(run.result as Deferred.Deferred<A, E>)).pipe(
    Effect.onInterrupt(() => (--run.waiters === 0 ? abandon : Effect.void)),
  );
};

const interruptSharedRun = (run: SharedRun) =>
  run.fiber === undefined ? Effect.void : Fiber.interrupt(run.fiber);

export function createAtomCommandScheduler(): AtomCommandScheduler {
  const registryStates = new WeakMap<AtomRegistry.AtomRegistry, AtomCommandSchedulerState>();
  const stateFor = (registry: AtomRegistry.AtomRegistry) => {
    let state = registryStates.get(registry);
    if (state === undefined) {
      state = { serial: new Map(), singleFlight: new Map(), latest: new Map() };
      registryStates.set(registry, state);
    }
    return state;
  };

  const serial = <A, E, R>(
    lanes: AtomCommandSchedulerState["serial"],
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const lane = lanes.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        lanes.set(key, lane);
        lane.users++;
        return lane;
      }),
      (lane) => lane.semaphore.withPermit(effect),
      (lane) =>
        Effect.sync(() => {
          if (--lane.users === 0) lanes.delete(key);
        }),
    );

  const singleFlight = <A, E, R>(
    flights: AtomCommandSchedulerState["singleFlight"],
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        let flight = flights.get(key);
        if (flight === undefined) {
          const started: SharedRun = {
            result: Deferred.makeUnsafe(),
            waiters: 0,
            fiber: undefined,
          };
          flight = started;
          flights.set(key, started);
          const context = yield* Effect.context<R>();
          yield* startSharedRun(
            started,
            effect.pipe(
              Effect.provide(context),
              Effect.ensuring(
                Effect.sync(() => {
                  if (flights.get(key) === started) flights.delete(key);
                }),
              ),
            ),
          );
        }
        const joined = flight;
        return yield* awaitSharedRun<A, E>(
          joined,
          restore,
          Effect.suspend(() => {
            // Left the map first, so a caller arriving during the interrupt starts a fresh run.
            if (flights.get(key) === joined) flights.delete(key);
            return interruptSharedRun(joined);
          }),
        );
      }),
    );

  const latest = <A, E, R>(
    lanes: AtomCommandSchedulerState["latest"],
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<R>();
        const existing = lanes.get(key);
        const lane = existing ?? { pending: undefined };
        lanes.set(key, lane);
        // Callers that queue behind a run share the next one, which runs the newest of them.
        const batch = lane.pending ?? {
          result: Deferred.makeUnsafe(),
          waiters: 0,
          fiber: undefined,
          start: Effect.void,
        };
        batch.start = startSharedRun(batch, Effect.provide(effect, context));
        lane.pending = batch;

        if (existing === undefined) {
          const drain: Effect.Effect<void> = Effect.suspend(() => {
            const next = lane.pending;
            if (next === undefined) {
              lanes.delete(key);
              return Effect.void;
            }
            lane.pending = undefined;
            return next.start.pipe(
              Effect.andThen(Deferred.await(next.result)),
              Effect.exit,
              Effect.andThen(drain),
            );
          });
          yield* drain.pipe(Effect.forkDetach({ startImmediately: true }));
        }
        return yield* awaitSharedRun<A, E>(
          batch,
          restore,
          Effect.suspend(() => {
            if (lane.pending === batch) lane.pending = undefined;
            return interruptSharedRun(batch);
          }),
        );
      }),
    );

  return {
    schedule: (registry, concurrency, input, effect) =>
      concurrency.mode === "parallel"
        ? effect
        : Effect.suspend(() => {
            const key = concurrency.key(input);
            const state = stateFor(registry);
            switch (concurrency.mode) {
              case "serial":
                return serial(state.serial, key, effect);
              case "singleFlight":
                return singleFlight(state.singleFlight, key, effect);
              case "latest":
                return latest(state.latest, key, effect);
            }
          }),
  };
}

const settleAtEdge = <A, E>(
  effect: Effect.Effect<A, E>,
  options: AtomCommandOptions,
  reporter: AtomCommandReporter,
): Promise<AtomCommandResult<A, E>> =>
  Effect.runPromiseExit(effect, { signal: options.signal }).then((exit) => {
    const result = AsyncResult.fromExit(exit);
    reportAtomCommandResult(result, options, reporter);
    return result;
  });

/** Starts a command from outside Effect. Effect callers yield `command.run` instead. */
export function runAtomCommand<W, A, E>(
  registry: AtomRegistry.AtomRegistry,
  command: AtomCommand<W, A, E>,
  input: W,
  options: AtomCommandOptions = {},
  reporter: AtomCommandReporter = console,
): Promise<AtomCommandResult<A, E>> {
  return settleAtEdge(
    Effect.suspend(() => command.run(registry, input)),
    { ...options, label: options.label ?? command.label },
    reporter,
  );
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
  const squashed = Cause.squash(result.cause);
  // A server `Effect.die("text")` decodes over RPC as a bare string; callers read `Error`s.
  return typeof squashed === "string" ? new Error(squashed) : squashed;
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

export interface AtomQueryOptions extends AtomCommandOptions {
  /**
   * Force a fresh execution instead of accepting a value the atom already
   * holds (e.g. an SWR-cached result within its stale window). Used by
   * verification flows where a cached failure must not satisfy a retry.
   */
  readonly refresh?: boolean;
}

/**
 * A query atom's settled value. The atom stays mounted while the caller waits, and
 * interrupting the caller releases it.
 */
export const awaitAtomResult = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options: Pick<AtomQueryOptions, "refresh"> = {},
): Effect.Effect<A, E> =>
  Effect.scoped(
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

/** Reads a query atom from outside Effect. Effect callers yield `awaitAtomResult` instead. */
export function executeAtomQuery<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options: AtomQueryOptions = {},
  reporter: AtomCommandReporter = console,
): Promise<AtomCommandResult<A, E>> {
  return settleAtEdge(awaitAtomResult(registry, atom, options), options, reporter);
}

/** Runs an effect on the calling fiber with the services of an atom runtime. */
export const provideAtomRuntime =
  <R, ER>(registry: AtomRegistry.AtomRegistry, runtime: Atom.AtomRuntime<R, ER>) =>
  <A, E>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | ER> =>
    Effect.scoped(
      AtomRegistry.mount(registry, runtime).pipe(
        Effect.andThen(AtomRegistry.getResult(registry, runtime)),
        Effect.flatMap((context) => Effect.provide(effect, context)),
      ),
    );

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
      scheduler.schedule(
        registry,
        concurrency,
        input,
        Effect.suspend(() => options.execute(input, registry)).pipe(
          provideAtomRuntime(registry, runtime),
        ),
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

/** Where a query's answer is persisted, so an action's reply can be saved where a read would be. */
export const queryPersistenceKey = (label: string, input: unknown): string =>
  JSON.stringify([label, input]);

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

const isStale = (result: AsyncResult.AsyncResult<unknown, unknown>, staleTimeMs: number) => {
  if (result.waiting) return false;
  const success =
    result._tag === "Failure" ? Option.getOrUndefined(result.previousSuccess) : result;
  if (success?._tag !== "Success") return result._tag === "Failure";
  // @effect-diagnostics-next-line globalDate:off - `AsyncResult` timestamps come from `Date.now`.
  return Date.now() - success.timestamp >= staleTimeMs;
};

/**
 * Stale-while-revalidate on every mount. `Atom.swr` checks only when its node builds, which an idle
 * TTL skips on a remount; this layer has no TTL (a transform drops it) while `self` keeps the cache.
 * It reads `self` as a dependency, not a subscription, so `self` goes idle with its last reader.
 */
export const revalidateOnMount =
  (staleTimeMs: number) =>
  <A, E>(
    self: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  ): Atom.Atom<AsyncResult.AsyncResult<A, E>> =>
    Atom.transform(
      self,
      (get) => {
        const current = get(self);
        if (Option.isNone(get.self()) && isStale(current, staleTimeMs)) {
          let active = true;
          get.addFinalizer(() => {
            active = false;
          });
          // Deferred out of the build, which runs while React renders. A plain read drops this
          // node before the task runs, so only a mount refetches.
          get.registry.schedulerAsync.makeDispatcher().scheduleTask(() => {
            if (active && isStale(get.once(self), staleTimeMs)) get.refresh(self);
          }, 0);
        }
        return current;
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

export function environmentConnectionAtom<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  environmentId: EnvironmentIdType,
) {
  return environmentConnectionAtoms(runtime)(environmentId);
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
): (
  target: { readonly environmentId: EnvironmentIdType; readonly input: Input },
  mountScope?: string,
) => Atom.Atom<AsyncResult.AsyncResult<A, E | ER | Error>> {
  const connectionAtom = environmentConnectionAtoms(runtime);
  // `Atom.family` holds members weakly and the mounted layer has no TTL, so each member lives
  // as long as its cache: keyed weakly, this lets both go once the cache's TTL ends.
  const cacheFamily = Atom.family((key: string) => {
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
                      .execute(
                        target.input,
                        emit,
                        Option.flatMap(
                          get.self<AsyncResult.AsyncResult<A, unknown>>(),
                          AsyncResult.value,
                        ),
                      )
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
                  ...translatableMessage(
                    connectionState.phase === "offline"
                      ? msg("Environment {environmentId} is offline.", {
                          environmentId: target.environmentId,
                        })
                      : connectionState.phase === "blocked"
                        ? msg("Environment {environmentId} is blocked.", {
                            environmentId: target.environmentId,
                          })
                        : msg("Environment {environmentId} is not connected.", {
                            environmentId: target.environmentId,
                          }),
                  ),
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
        const cacheKey = queryPersistenceKey(options.label, target.input);
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
          // Readers must not wait on the disk: web saves one IndexedDB row per listed PR's stats.
          // The save ends with the query, so a removed environment's cache stays cleared.
          return yield* answer().pipe(
            Effect.tap((value) =>
              persistence.save(target.environmentId, cacheKey, value).pipe(Effect.forkScoped),
            ),
          );
        });
      })
      .pipe(Atom.setIdleTTL(idleTtlMs));
    const isFinal = (result: AsyncResult.AsyncResult<A, unknown>) =>
      options.isFinal !== undefined && Option.exists(AsyncResult.value(result), options.isFinal);
    const intervalQuery =
      options.refreshIntervalMs === undefined
        ? queryAtom
        : queryAtom.pipe(refreshEveryUntilFinal(options.refreshIntervalMs, isFinal));
    const refreshTrigger = options.refreshTrigger?.(target, intervalQuery);
    return (
      refreshTrigger === undefined
        ? intervalQuery
        : intervalQuery.pipe(refreshOnSignalWhileRead(refreshTrigger, isFinal))
    ).pipe(Atom.setIdleTTL(idleTtlMs));
  });
  type QueryAtom = ReturnType<typeof cacheFamily>;
  const membersByCache = new WeakMap<QueryAtom, Map<string | undefined, QueryAtom>>();
  return (target, mountScope) => {
    const key = environmentRpcKey(target);
    const cache = cacheFamily(key);
    let members = membersByCache.get(cache);
    if (members === undefined) {
      members = new Map();
      membersByCache.set(cache, members);
    }
    const existing = members.get(mountScope);
    if (existing !== undefined) return existing;
    const member = cache.pipe(
      revalidateOnMount(options.staleTimeMs ?? 30_000),
      Atom.withLabel(`${options.label}:${key}${mountScope === undefined ? "" : `:${mountScope}`}`),
    );
    members.set(mountScope, member);
    return member;
  };
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
  const idleTtlMs = options.idleTtlMs ?? 5 * 60_000;
  const label = (key: string) =>
    options.sensitiveInput
      ? `${options.label}:${parseEnvironmentRpcKey<Input>(key).environmentId}`
      : `${options.label}:${key}`;
  const live = Atom.family((key: string) => {
    const target = parseEnvironmentRpcKey<Input>(key);
    return runtime
      .atom(
        Stream.suspend(() =>
          followStreamInEnvironment(target.environmentId, options.subscribe(target.input)),
        ).pipe(options.completeWhen ? Stream.takeUntil(options.completeWhen) : (stream) => stream),
      )
      .pipe(Atom.setIdleTTL(idleTtlMs), Atom.withLabel(label(key)));
  });
  const { completeWhen, completedTtlMs } = options;
  if (completeWhen === undefined || completedTtlMs === undefined) {
    return (target: { readonly environmentId: EnvironmentIdType; readonly input: Input }) =>
      live(environmentRpcKey(target));
  }
  const completed = Atom.family((key: string) =>
    Atom.make(Option.none<A>()).pipe(
      Atom.setIdleTTL(completedTtlMs),
      Atom.withLabel(`${label(key)}:completed`),
    ),
  );
  // Reading `completed` first drops the live subscription once its value is final.
  const family = Atom.family((key: string) =>
    Atom.make((get) => {
      const done = get(completed(key));
      if (Option.isSome(done)) return AsyncResult.success(done.value);
      const result = get(live(key));
      if (AsyncResult.isSuccess(result) && !result.waiting && completeWhen(result.value)) {
        get.set(completed(key), Option.some(result.value));
      }
      return result;
    }).pipe(Atom.setIdleTTL(idleTtlMs), Atom.withLabel(label(key))),
  );
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
      previous: Option.Option<EnvironmentRpcSuccess<TTag>>,
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
      previous: Option.Option<EnvironmentRpcSuccess<TTag>>,
    ) => options.execute?.(input, emit, previous) ?? request(options.tag, input),
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
    readonly completedTtlMs?: number;
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
    ...(options.completedTtlMs === undefined ? {} : { completedTtlMs: options.completedTtlMs }),
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
  Started = undefined,
>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: {
    readonly label: string;
    readonly tag: TTag;
    /** Runs once authorized, as the request starts; what it returns reaches `onSuccess`. */
    readonly onStart?: (
      target: {
        readonly environmentId: EnvironmentIdType;
        readonly input: NoInfer<Input>;
      },
      registry: AtomRegistry.AtomRegistry,
    ) => Started;
    readonly execute?: (
      input: Input,
      registry: AtomRegistry.AtomRegistry,
      environmentId: EnvironmentIdType,
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
      started: Started | undefined,
    ) => Effect.Effect<void, never, R>;
    readonly onSettled?: (
      target: {
        readonly environmentId: EnvironmentIdType;
        readonly input: NoInfer<Input>;
      },
      registry: AtomRegistry.AtomRegistry,
      exit: Exit.Exit<EnvironmentRpcSuccess<TTag>, unknown>,
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
      let started: Started | undefined;
      // Routing requires consent on the origin as well as the actual destination.
      // The transport check below deliberately checks the destination again.
      return permissions.authorize(registry, environmentId, input).pipe(
        Effect.andThen(() => {
          started = options.onStart?.(target, registry);
          return (
            options.execute?.(input, registry, environmentId) ?? requestGuarded(options.tag, input)
          );
        }),
        Effect.provideService(RpcPermissionGuard, {
          authorize: (id, method, payload) =>
            createCommandPermissions(runtime, method).authorize(registry, id, payload),
        }),
        Effect.tap(
          (result) => options.onSuccess?.(target, registry, result, started) ?? Effect.void,
        ),
        Effect.onExit((exit) => options.onSettled?.(target, registry, exit) ?? Effect.void),
      );
    },
  });
  return {
    ...command,
    requiredScopes: permissions.requiredScopes,
    permissionAtom: permissions.permissionAtom,
  };
}
