export { runStreamInEnvironment, followStreamInEnvironment } from "./environmentStreams.ts";
import type { QueryPersistence } from "./queryPersistence.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { followStreamInEnvironment } from "./environmentStreams.ts";
import { reuseUnchanged } from "./serverConfigProjection.ts";
import {
  type ClientGuardedRpcTag,
  type EnvironmentId as EnvironmentIdType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AsyncResult,
  Atom,
  AtomRegistry,
} from "effect/reactivity";
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
import type { AtomCommandConcurrency, AtomCommandScheduler, EnvironmentCommandAtomOptions, EnvironmentQueryAtomOptions, EnvironmentSubscriptionAtomOptions, QueryAnswerHandler } from "./runtimePart2.ts";
import { createRuntimeCommand, environmentRpcKey, parseEnvironmentRpcKey, pendingOnceSessionReplaced, runInEnvironment } from "./runtimePart2.ts";
export type {
  AtomCommand,
  AtomCommandConcurrency,
  AtomCommandFailure,
  AtomCommandOptions,
  AtomCommandReporter,
  AtomCommandResult,
  AtomCommandScheduler,
  AtomCommandSuccess,
  AtomQueryOptions,
  QueryAnswerHandler,
  SettledAsyncResult,
} from "./runtimePart2.ts";
export {
  createAtomCommandScheduler,
  createRuntimeCommand,
  executeAtomQuery,
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  reportAtomCommandResult,
  runAtomCommand,
  scheduleAtomCommandEffect,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "./runtimePart2.ts";

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
