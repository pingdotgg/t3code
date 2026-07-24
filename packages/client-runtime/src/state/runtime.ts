import { EnvironmentId, type EnvironmentId as EnvironmentIdType } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentNotRegisteredError, EnvironmentRegistry } from "../connection/registry.ts";
import {
  type EnvironmentRpcInput,
  type EnvironmentRpcStreamFailure,
  type EnvironmentRpcStreamValue,
  type EnvironmentStreamCommandRpcTag,
  type EnvironmentSubscriptionRpcTag,
  type EnvironmentUnaryRpcTag,
  request,
  runStream,
  subscribe,
} from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";

interface EnvironmentAtomOptions<Input, A, E, R> {
  readonly label: string;
  readonly execute: (input: Input) => Effect.Effect<A, E, R>;
  readonly scheduler?: AtomCommandScheduler;
  readonly concurrency?: AtomCommandConcurrency<{
    readonly environmentId: EnvironmentIdType;
    readonly input: Input;
  }>;
}

interface EnvironmentQueryAtomOptions<Input, A, E, R> extends EnvironmentAtomOptions<
  Input,
  A,
  E,
  R
> {
  readonly staleTimeMs?: number;
  readonly idleTtlMs?: number;
  readonly refreshIntervalMs?: number;
}

interface EnvironmentSubscriptionAtomOptions<Input, A, E, R> {
  readonly label: string;
  readonly subscribe: (input: Input) => Stream.Stream<A, E, R>;
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
  readonly forceRefresh?: boolean;
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
  /** Every invocation runs independently. */
  | { readonly mode: "parallel" }
  | {
      /**
       * `serial` preserves every invocation in FIFO order, `singleFlight` shares an active
       * invocation, and `latest` coalesces queued invocations to the newest input.
       */
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

export async function executeAtomCommand<A, E>(
  execute: () => Promise<Exit.Exit<A, E>>,
  options: AtomCommandOptions = {},
  reporter: AtomCommandReporter = console,
): Promise<AtomCommandResult<A, E>> {
  const result = await settleAsyncResult(execute);
  reportAtomCommandResult(result, options, reporter);
  return result;
}

export async function executeAtomQuery<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options: AtomCommandOptions = {},
  reporter: AtomCommandReporter = console,
): Promise<AtomCommandResult<A, E>> {
  const hasCachedNode = options.forceRefresh ? registry.getNodes().has(atom) : false;
  const query = Effect.scoped(
    Effect.gen(function* () {
      yield* AtomRegistry.mount(registry, atom);
      if (hasCachedNode) {
        yield* Effect.sync(() => registry.refresh(atom));
      }
      return yield* AtomRegistry.getResult(registry, atom, {
        suspendOnWaiting: true,
      });
    }),
  );
  return executeAtomCommand(() => Effect.runPromiseExit(query), options, reporter);
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

export function createRuntimeStreamCommand<R, ER, W, A, E>(
  runtime: Atom.AtomRuntime<R, ER>,
  options: {
    readonly label: string;
    readonly execute: (input: W, registry: AtomRegistry.AtomRegistry) => Stream.Stream<A, E, R>;
    readonly scheduler?: AtomCommandScheduler;
    readonly concurrency?: AtomCommandConcurrency<W>;
  },
): AtomCommand<W, A, E | ER | Cause.NoSuchElementError> {
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

export function environmentRpcKey<Input>(target: {
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

export function runInEnvironment<A, E, R>(
  environmentId: EnvironmentIdType,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | EnvironmentNotRegisteredError,
  EnvironmentRegistry | Exclude<R, EnvironmentSupervisor>
> {
  return EnvironmentRegistry.pipe(
    Effect.flatMap((registry) => registry.run(environmentId, effect)),
  );
}

export function runStreamInEnvironment<A, E, R>(
  environmentId: EnvironmentIdType,
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<
  A,
  E | EnvironmentNotRegisteredError,
  EnvironmentRegistry | Exclude<R, EnvironmentSupervisor>
> {
  return Stream.unwrap(
    EnvironmentRegistry.pipe(Effect.map((registry) => registry.runStream(environmentId, stream))),
  );
}

export function followStreamInEnvironment<A, E, R>(
  environmentId: EnvironmentIdType,
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, EnvironmentRegistry | Exclude<R, EnvironmentSupervisor>> {
  return Stream.unwrap(
    EnvironmentRegistry.pipe(
      Effect.map((registry) => registry.followStream(environmentId, stream)),
    ),
  );
}

function createEnvironmentQueryAtomFamily<R, ER, Input, A, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: EnvironmentQueryAtomOptions<Input, A, E, EnvironmentSupervisor | R>,
): (target: {
  readonly environmentId: EnvironmentIdType;
  readonly input: Input;
}) => Atom.Atom<AsyncResult.AsyncResult<A, E | ER | Error>> {
  const rpcGenerationAtom = Atom.family((environmentId: EnvironmentIdType) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.state).pipe(
                Stream.filterMap((state) =>
                  state.phase === "connected" ? Result.succeed(state.generation) : Result.failVoid,
                ),
                Stream.changes,
                Stream.map<number, number | null>((generation) => generation),
              ),
            ),
          ),
        ),
      ),
      { initialValue: null },
    ),
  );
  const family = Atom.family((key: string) => {
    const target = parseEnvironmentRpcKey<Input>(key);
    const idleTtlMs = options.idleTtlMs ?? 5 * 60_000;
    const queryAtom = runtime
      .atom((get) => {
        const generation = Option.getOrNull(
          AsyncResult.value(get(rpcGenerationAtom(target.environmentId))),
        );
        if (generation === null) {
          return Effect.never;
        }
        return runInEnvironment(target.environmentId, options.execute(target.input));
      })
      .pipe(
        Atom.swr({
          staleTime: options.staleTimeMs ?? 30_000,
          revalidateOnMount: true,
        }),
        Atom.setIdleTTL(idleTtlMs),
      );
    return (
      options.refreshIntervalMs === undefined
        ? queryAtom
        : queryAtom.pipe(Atom.withRefresh(options.refreshIntervalMs))
    ).pipe(Atom.setIdleTTL(idleTtlMs), Atom.withLabel(`${options.label}:${key}`));
  });
  return (target) => family(environmentRpcKey(target));
}

export function createEnvironmentSubscriptionAtomFamily<R, ER, Input, A, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: EnvironmentSubscriptionAtomOptions<Input, A, E, EnvironmentSupervisor | R>,
) {
  const family = Atom.family((key: string) => {
    const target = parseEnvironmentRpcKey<Input>(key);
    return runtime
      .atom(followStreamInEnvironment(target.environmentId, options.subscribe(target.input)))
      .pipe(
        Atom.setIdleTTL(options.idleTtlMs ?? 5 * 60_000),
        Atom.withLabel(`${options.label}:${key}`),
      );
  });
  return (target: { readonly environmentId: EnvironmentIdType; readonly input: Input }) =>
    family(environmentRpcKey(target));
}

export function createEnvironmentCommand<R, ER, Input, A, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: EnvironmentAtomOptions<Input, A, E, EnvironmentSupervisor | R>,
) {
  return createRuntimeCommand(runtime, {
    label: options.label,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    execute: (target) => runInEnvironment(target.environmentId, options.execute(target.input)),
  });
}

function createEnvironmentStreamCommand<R, ER, Input, A, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: {
    readonly label: string;
    readonly execute: (input: Input) => Stream.Stream<A, E, EnvironmentSupervisor | R>;
    readonly scheduler?: AtomCommandScheduler;
    readonly concurrency?: AtomCommandConcurrency<{
      readonly environmentId: EnvironmentIdType;
      readonly input: Input;
    }>;
  },
) {
  return createRuntimeStreamCommand(runtime, {
    label: options.label,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    execute: (target) =>
      runStreamInEnvironment(target.environmentId, options.execute(target.input)).pipe(
        Stream.withSpan(options.label),
      ),
  });
}

export function createEnvironmentRpcQueryAtomFamily<R, ER, TTag extends EnvironmentUnaryRpcTag>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: {
    readonly label: string;
    readonly tag: TTag;
    readonly staleTimeMs?: number;
    readonly idleTtlMs?: number;
    readonly refreshIntervalMs?: number;
  },
) {
  return createEnvironmentQueryAtomFamily(runtime, {
    label: options.label,
    ...(options.staleTimeMs === undefined ? {} : { staleTimeMs: options.staleTimeMs }),
    ...(options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs }),
    ...(options.refreshIntervalMs === undefined
      ? {}
      : { refreshIntervalMs: options.refreshIntervalMs }),
    execute: (input: EnvironmentRpcInput<TTag>) => request(options.tag, input),
  });
}

export function createEnvironmentRpcSubscriptionAtomFamily<
  R,
  ER,
  TTag extends EnvironmentSubscriptionRpcTag,
  B = EnvironmentRpcStreamValue<TTag>,
>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: {
    readonly label: string;
    readonly tag: TTag;
    readonly idleTtlMs?: number;
    readonly transform?: (
      stream: Stream.Stream<
        EnvironmentRpcStreamValue<TTag>,
        EnvironmentRpcStreamFailure<TTag>,
        EnvironmentSupervisor | R
      >,
    ) => Stream.Stream<B, EnvironmentRpcStreamFailure<TTag>, EnvironmentSupervisor | R>;
  },
) {
  return createEnvironmentSubscriptionAtomFamily(runtime, {
    label: options.label,
    ...(options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs }),
    subscribe: (input: EnvironmentRpcInput<TTag>) => {
      const stream = subscribe(options.tag, input);
      return options.transform === undefined
        ? (stream as Stream.Stream<B, EnvironmentRpcStreamFailure<TTag>, EnvironmentSupervisor | R>)
        : options.transform(stream);
    },
  });
}

export function createEnvironmentRpcCommand<R, ER, TTag extends EnvironmentUnaryRpcTag>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: {
    readonly label: string;
    readonly tag: TTag;
    readonly scheduler?: AtomCommandScheduler;
    readonly concurrency?: AtomCommandConcurrency<{
      readonly environmentId: EnvironmentIdType;
      readonly input: EnvironmentRpcInput<TTag>;
    }>;
  },
) {
  return createEnvironmentCommand(runtime, {
    label: options.label,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    execute: (input: EnvironmentRpcInput<TTag>) => request(options.tag, input),
  });
}

export function createEnvironmentRpcStreamCommand<
  R,
  ER,
  TTag extends EnvironmentStreamCommandRpcTag,
>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: {
    readonly label: string;
    readonly tag: TTag;
    readonly scheduler?: AtomCommandScheduler;
    readonly concurrency?: AtomCommandConcurrency<{
      readonly environmentId: EnvironmentIdType;
      readonly input: EnvironmentRpcInput<TTag>;
    }>;
  },
) {
  return createEnvironmentStreamCommand(runtime, {
    label: options.label,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    execute: (input: EnvironmentRpcInput<TTag>) => runStream(options.tag, input),
  });
}
