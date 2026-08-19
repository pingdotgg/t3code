import * as NodeAsyncHooks from "node:async_hooks";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scheduler from "effect/Scheduler";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

import type {
  Contribution,
  ContributionData,
  PluginActivationContext,
  PluginDefinition,
  PluginRuntimeContributionSnapshot,
  PluginRuntimeOptions,
  PluginRuntimeSnapshot,
} from "./contract.ts";
import {
  affectedPluginIds,
  isPluginPlanningError,
  planComposition,
  type PluginPlanningError,
} from "./planner.ts";

interface LiveContribution {
  readonly contribution: Contribution;
  readonly value: unknown;
}

interface LivePlugin {
  readonly definition: PluginDefinition;
  readonly scope: Scope.Closeable;
  readonly contributions: ReadonlyMap<string, ReadonlyArray<LiveContribution>>;
  readonly cleanupErrors: Array<unknown>;
}

interface LiveComposition {
  readonly generation: number;
  readonly plugins: ReadonlyArray<LivePlugin>;
  readonly snapshot: PluginRuntimeSnapshot;
}

type RuntimeOperation = "reconcile" | "dispose" | "invoke";
type PluginLifecycleCallback = "activate" | "finalizer";
type PluginCallback = PluginLifecycleCallback | "contribution";

interface PluginCallbackContext {
  active: boolean;
  readonly callback: PluginCallback;
  readonly pluginId: string;
}

interface PluginEffectCallbackContext extends PluginCallbackContext {
  readonly runtime: object;
}

class PluginEffectCallback extends Context.Reference<PluginEffectCallbackContext | undefined>(
  "@t3tools/plugin-runtime/runtime/PluginEffectCallback",
  { defaultValue: () => undefined },
) {}

interface CleanupFailure {
  readonly error: unknown;
  readonly pluginId: string;
}

class PluginResolutionError extends Schema.TaggedErrorClass<PluginResolutionError>()(
  "PluginResolutionError",
  { capability: Schema.String, pluginId: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} cannot resolve inactive capability: ${this.capability}`;
  }
}

class PluginUndeclaredCapabilityError extends Schema.TaggedErrorClass<PluginUndeclaredCapabilityError>()(
  "PluginUndeclaredCapabilityError",
  { capability: Schema.String, pluginId: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} did not declare capability: ${this.capability}`;
  }
}

class PluginActivationContextExpiredError extends Schema.TaggedErrorClass<PluginActivationContextExpiredError>()(
  "PluginActivationContextExpiredError",
  {
    method: Schema.Literals(["resolve", "register", "onDispose"]),
    pluginId: Schema.String,
  },
) {
  override get message(): string {
    return `activation context for ${this.pluginId} is no longer active (${this.method})`;
  }
}

class PluginCallbackError extends Schema.TaggedErrorClass<PluginCallbackError>()(
  "PluginCallbackError",
  {
    callback: Schema.Literals(["activate", "finalizer"]),
    cause: Schema.Defect(),
    pluginId: Schema.String,
  },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} ${this.callback} callback failed`;
  }
}

class PluginStagingError extends Schema.TaggedErrorClass<PluginStagingError>()(
  "PluginStagingError",
  { pluginId: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} was not staged`;
  }
}

export class PluginDuplicateContributionError extends Schema.TaggedErrorClass<PluginDuplicateContributionError>()(
  "PluginDuplicateContributionError",
  {
    firstPluginId: Schema.String,
    id: Schema.String,
    secondPluginId: Schema.String,
    slot: Schema.String,
  },
) {
  override get message(): string {
    return `Duplicate plugin contribution ${this.slot}/${this.id} from ${this.firstPluginId} and ${this.secondPluginId}`;
  }
}

class PluginRuntimeDisposedError extends Schema.TaggedErrorClass<PluginRuntimeDisposedError>()(
  "PluginRuntimeDisposedError",
  { operation: Schema.Literals(["reconcile", "dispose", "invoke"]) },
) {
  override get message(): string {
    return `Plugin runtime is disposed; cannot ${this.operation}`;
  }
}

class PluginRuntimeReentrancyError extends Schema.TaggedErrorClass<PluginRuntimeReentrancyError>()(
  "PluginRuntimeReentrancyError",
  {
    callback: Schema.Literals(["activate", "contribution", "finalizer"]),
    operation: Schema.Literals(["reconcile", "dispose", "invoke"]),
    pluginId: Schema.String,
  },
) {
  override get message(): string {
    return `Plugin runtime ${this.operation} is reentrant from ${this.callback} callback for ${this.pluginId}`;
  }
}

class PluginRuntimeCleanupError extends Schema.TaggedErrorClass<PluginRuntimeCleanupError>()(
  "PluginRuntimeCleanupError",
  {
    failures: Schema.Array(
      Schema.Struct({
        cause: Schema.Defect(),
        pluginId: Schema.String,
      }),
    ),
  },
) {
  override get message(): string {
    return `Failed to close plugin scopes (${this.failures.length} cleanup error${this.failures.length === 1 ? "" : "s"})`;
  }
}

export type PluginRuntimeReconcileError =
  | PluginPlanningError
  | PluginCallbackError
  | PluginDuplicateContributionError
  | PluginRuntimeDisposedError
  | PluginRuntimeReentrancyError
  | PluginSnapshotValidationError
  | PluginStagingError;

export class PluginSnapshotValidationError extends Schema.TaggedErrorClass<PluginSnapshotValidationError>()(
  "PluginSnapshotValidationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Plugin contribution snapshot validation failed";
  }
}

export type PluginRuntimeDisposeError = PluginRuntimeCleanupError | PluginRuntimeReentrancyError;

export class PluginContributionGenerationError extends Schema.TaggedErrorClass<PluginContributionGenerationError>()(
  "PluginContributionGenerationError",
  { actual: Schema.Int, expected: Schema.Int },
) {
  override get message(): string {
    return `Plugin contribution generation changed from ${this.expected} to ${this.actual}`;
  }
}

export class PluginContributionNotFoundError extends Schema.TaggedErrorClass<PluginContributionNotFoundError>()(
  "PluginContributionNotFoundError",
  { id: Schema.String, slot: Schema.String },
) {
  override get message(): string {
    return `Plugin contribution not found: ${this.slot}/${this.id}`;
  }
}

export type PluginRuntimeContributionError =
  | PluginContributionGenerationError
  | PluginContributionNotFoundError
  | PluginRuntimeDisposedError
  | PluginRuntimeReentrancyError;

export class PluginRuntime extends Context.Service<
  PluginRuntime,
  {
    readonly reconcile: (
      definitions: ReadonlyArray<PluginDefinition>,
    ) => Effect.Effect<PluginRuntimeSnapshot, PluginRuntimeReconcileError>;
    readonly snapshot: Effect.Effect<PluginRuntimeSnapshot>;
    readonly contributions: (slot: string) => Effect.Effect<PluginRuntimeContributionSnapshot>;
    readonly useContribution: <Value, Success, Failure, Requirements>(
      slot: string,
      id: string,
      generation: number,
      use: (value: Value) => Effect.Effect<Success, Failure, Requirements>,
    ) => Effect.Effect<Success, Failure | PluginRuntimeContributionError, Requirements>;
    readonly dispose: Effect.Effect<void, PluginRuntimeDisposeError>;
  }
>()("@t3tools/plugin-runtime/runtime/PluginRuntime") {}

const createNullPrototypeRecord = <Value>(): Record<string, Value> =>
  Object.create(null) as Record<string, Value>;

const sameStringRecord = (
  left: Readonly<Partial<Record<string, string>>>,
  right: Readonly<Partial<Record<string, string>>>,
): boolean => {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
};

const cloneContributionData = (
  value: ContributionData,
  ancestors = new WeakSet<object>(),
): ContributionData => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Contribution data numbers must be finite");
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("Contribution data must contain only JSON-compatible values");
  }
  if (ancestors.has(value)) throw new TypeError("Contribution data cannot contain cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const clone: Array<ContributionData> = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Contribution data arrays cannot contain holes");
        }
        clone.push(cloneContributionData(value[index]!, ancestors));
      }
      return Object.freeze(clone);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Contribution data objects must use a plain or null prototype");
    }
    const clone = createNullPrototypeRecord<ContributionData>();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError("Contribution data objects cannot use symbol keys");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
        throw new TypeError("Contribution data objects must use enumerable data properties");
      }
      clone[key] = cloneContributionData(descriptor.value as ContributionData, ancestors);
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
};

const detachContribution = (contribution: Contribution): Contribution =>
  Object.freeze({
    id: contribution.id,
    label: contribution.label,
    ...(contribution.data === undefined ? {} : { data: cloneContributionData(contribution.data) }),
  });

const snapshotDefinitions = (
  definitions: ReadonlyArray<PluginDefinition>,
): ReadonlyArray<PluginDefinition> =>
  definitions.map((definition) => {
    const requires =
      definition.requires === undefined ? undefined : Object.freeze([...definition.requires]);
    const provides =
      definition.provides === undefined
        ? undefined
        : Object.freeze(Object.assign(createNullPrototypeRecord<unknown>(), definition.provides));
    return Object.freeze({
      id: definition.id,
      version: definition.version,
      activate: definition.activate,
      ...(requires === undefined ? {} : { requires }),
      ...(provides === undefined ? {} : { provides }),
    });
  });

const emptySnapshot = (): PluginRuntimeSnapshot =>
  Object.freeze({
    active: Object.freeze([]),
    blocked: Object.freeze(createNullPrototypeRecord<string>()),
    contributions: Object.freeze(createNullPrototypeRecord<ReadonlyArray<Contribution>>()),
  });

const snapshotOf = (
  plugins: ReadonlyArray<LivePlugin>,
  blocked: Readonly<Record<string, string>>,
): PluginRuntimeSnapshot => {
  const contributions = createNullPrototypeRecord<ReadonlyArray<Contribution>>();
  for (const plugin of plugins) {
    for (const [slot, registrations] of plugin.contributions) {
      const values = contributions[slot] ?? [];
      contributions[slot] = Object.freeze([
        ...values,
        ...registrations.map((registration) => registration.contribution),
      ]);
    }
  }
  return Object.freeze({
    active: Object.freeze(plugins.map((plugin) => plugin.definition.id)),
    blocked: Object.freeze(Object.assign(createNullPrototypeRecord<string>(), blocked)),
    contributions: Object.freeze(contributions),
  });
};

const validateUniqueContributions = (
  plugins: ReadonlyArray<LivePlugin>,
): Effect.Effect<void, PluginDuplicateContributionError> =>
  Effect.gen(function* () {
    const owners = new Map<string, Map<string, string>>();
    for (const plugin of plugins) {
      for (const [slot, registrations] of plugin.contributions) {
        const slotOwners = owners.get(slot) ?? new Map<string, string>();
        owners.set(slot, slotOwners);
        for (const registration of registrations) {
          const id = registration.contribution.id;
          const firstPluginId = slotOwners.get(id);
          if (firstPluginId !== undefined) {
            return yield* new PluginDuplicateContributionError({
              firstPluginId,
              id,
              secondPluginId: plugin.definition.id,
              slot,
            });
          }
          slotOwners.set(id, plugin.definition.id);
        }
      }
    }
  });

export const make = (options: PluginRuntimeOptions = {}) =>
  Effect.gen(function* () {
    const parentScope = yield* Effect.scope;
    const transitionSemaphore = yield* Semaphore.make(1);
    const baseScheduler = yield* Scheduler.Scheduler;
    const runtimeIdentity = {};
    let current: LiveComposition = { generation: 0, plugins: [], snapshot: emptySnapshot() };
    let disposalStarted = false;
    let disposed = false;
    const callbackContext = new NodeAsyncHooks.AsyncLocalStorage<PluginCallbackContext>();

    const reportLifecycle = (
      phase: "activate" | "deactivate",
      pluginId: string,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        try {
          options.onLifecycle?.({ phase, pluginId });
        } catch (error) {
          try {
            options.onLifecycleError?.({ phase, pluginId, error });
          } catch {
            // Observer error reporting must never interrupt a commit or cleanup.
          }
        }
      });

    const reportCleanupErrors = (
      phase: "retire" | "rollback",
      failures: ReadonlyArray<CleanupFailure>,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        for (const { error } of failures) {
          try {
            options.onCleanupError?.({ phase, error });
          } catch {
            // Cleanup reporting must not replace activation errors or undo a committed snapshot.
          }
        }
      });

    const closePlugins = (
      plugins: ReadonlyArray<LivePlugin>,
      notifyDeactivation: boolean,
    ): Effect.Effect<ReadonlyArray<CleanupFailure>> =>
      Effect.gen(function* () {
        const failures: Array<CleanupFailure> = [];
        for (const plugin of plugins.toReversed()) {
          const closeExit = yield* Effect.exit(Scope.close(plugin.scope, Exit.void));
          if (Exit.isFailure(closeExit)) {
            failures.push({
              error: Cause.squash(closeExit.cause),
              pluginId: plugin.definition.id,
            });
          }
          for (const error of plugin.cleanupErrors.splice(0)) {
            failures.push({ error, pluginId: plugin.definition.id });
          }
          if (notifyDeactivation) {
            yield* reportLifecycle("deactivate", plugin.definition.id);
          }
        }
        return failures;
      });

    const invokePluginCallback = <Result>(
      callback: PluginLifecycleCallback,
      pluginId: string,
      invoke: () => Result | PromiseLike<Result>,
      onSettled?: () => void,
    ): Effect.Effect<Result, PluginCallbackError> => {
      const callbackState: PluginCallbackContext = { active: true, callback, pluginId };
      let expired = false;
      const expire = () => {
        if (expired) return;
        expired = true;
        onSettled?.();
      };
      const settleCallback = () => {
        callbackState.active = false;
        expire();
      };

      return Effect.tryPromise({
        try: async () => {
          try {
            const result = callbackContext.run(callbackState, invoke);
            if (typeof result === "object" && result !== null && "then" in result) {
              return await Promise.resolve(result).finally(settleCallback);
            }
            settleCallback();
            return result;
          } catch (error) {
            settleCallback();
            throw error;
          }
        },
        catch: (cause) => new PluginCallbackError({ callback, cause, pluginId }),
      }).pipe(Effect.ensuring(Effect.sync(expire)));
    };

    const activatePlugin = (
      definition: PluginDefinition,
      capabilities: ReadonlyMap<string, unknown>,
    ): Effect.Effect<LivePlugin, PluginCallbackError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const scope = yield* Scope.fork(parentScope, "sequential");
          const contributions = new Map<string, Array<LiveContribution>>();
          const cleanupErrors: Array<unknown> = [];
          const finalizers: Array<() => void | Promise<void>> = [];
          const plugin: LivePlugin = { definition, scope, contributions, cleanupErrors };
          let activating = true;
          const assertActivating = (method: "resolve" | "register" | "onDispose") => {
            if (!activating) {
              throw new PluginActivationContextExpiredError({ method, pluginId: definition.id });
            }
          };

          const context: PluginActivationContext = {
            resolve: <Service>(capability: string): Service => {
              assertActivating("resolve");
              if (!(definition.requires ?? []).includes(capability)) {
                throw new PluginUndeclaredCapabilityError({ capability, pluginId: definition.id });
              }
              if (!capabilities.has(capability)) {
                throw new PluginResolutionError({ capability, pluginId: definition.id });
              }
              return capabilities.get(capability) as Service;
            },
            register: (
              slot: string,
              contribution: Contribution,
              ...registeredValues: [] | [unknown]
            ) => {
              assertActivating("register");
              const values = contributions.get(slot) ?? [];
              const detachedContribution = detachContribution(contribution);
              values.push({
                contribution: detachedContribution,
                value: registeredValues.length === 0 ? detachedContribution : registeredValues[0],
              });
              contributions.set(slot, values);
            },
            onDispose: (finalizer) => {
              assertActivating("onDispose");
              finalizers.push(finalizer);
            },
          };

          const activationExit = yield* Effect.exit(
            restore(
              invokePluginCallback(
                "activate",
                definition.id,
                () => definition.activate(context),
                () => {
                  activating = false;
                },
              ),
            ),
          );
          for (const finalizer of finalizers) {
            const finalizerEffect = invokePluginCallback(
              "finalizer",
              definition.id,
              finalizer,
            ).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  cleanupErrors.push(error);
                }),
              ),
            );
            yield* Scope.addFinalizer(scope, finalizerEffect);
          }

          if (Exit.isFailure(activationExit)) {
            const failures = yield* closePlugins([plugin], false);
            yield* reportCleanupErrors("rollback", failures);
            return yield* Effect.failCause(activationExit.cause);
          }
          return plugin;
        }),
      );

    const reconcileEffect = (
      definitions: ReadonlyArray<PluginDefinition>,
    ): Effect.Effect<PluginRuntimeSnapshot, PluginRuntimeReconcileError> =>
      Effect.gen(function* () {
        if (disposalStarted) {
          return yield* new PluginRuntimeDisposedError({ operation: "reconcile" });
        }

        const plan = yield* Effect.try({
          try: () => planComposition(definitions),
          catch: (error) => {
            if (!isPluginPlanningError(error)) throw error;
            return error;
          },
        });
        const affected = affectedPluginIds(
          current.plugins.map((plugin) => plugin.definition),
          plan.definitions,
        );
        if (affected.size === 0 && sameStringRecord(current.snapshot.blocked, plan.blocked)) {
          return current.snapshot;
        }
        const currentById = new Map(
          current.plugins.map((plugin) => [plugin.definition.id, plugin]),
        );
        const capabilities = new Map<string, unknown>();
        for (const plugin of current.plugins) {
          if (affected.has(plugin.definition.id)) continue;
          for (const [capability, service] of Object.entries(plugin.definition.provides ?? {})) {
            capabilities.set(capability, service);
          }
        }

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const staged = new Map<string, LivePlugin>();
            const candidateExit = yield* Effect.exit(
              restore(
                Effect.gen(function* () {
                  for (const definition of plan.definitions) {
                    if (!affected.has(definition.id)) continue;
                    const plugin = yield* activatePlugin(definition, capabilities);
                    staged.set(definition.id, plugin);
                    for (const [capability, service] of Object.entries(definition.provides ?? {})) {
                      capabilities.set(capability, service);
                    }
                  }

                  const nextPlugins: Array<LivePlugin> = [];
                  for (const definition of plan.definitions) {
                    const plugin = staged.get(definition.id) ?? currentById.get(definition.id);
                    if (plugin === undefined) {
                      return yield* new PluginStagingError({ pluginId: definition.id });
                    }
                    nextPlugins.push(plugin);
                  }
                  yield* validateUniqueContributions(nextPlugins);
                  const snapshot = snapshotOf(nextPlugins, plan.blocked);
                  yield* Effect.try({
                    try: () => options.validateSnapshot?.(snapshot),
                    catch: (cause) => new PluginSnapshotValidationError({ cause }),
                  });
                  return {
                    generation: current.generation + 1,
                    plugins: nextPlugins,
                    snapshot,
                  };
                }),
              ),
            );
            if (Exit.isFailure(candidateExit)) {
              const failures = yield* closePlugins([...staged.values()], false);
              yield* reportCleanupErrors("rollback", failures);
              return yield* Effect.failCause(candidateExit.cause);
            }

            const previous = current.plugins.filter((plugin) => affected.has(plugin.definition.id));
            current = candidateExit.value;
            for (const plugin of staged.values()) {
              yield* reportLifecycle("activate", plugin.definition.id);
            }
            const failures = yield* closePlugins(previous, true);
            yield* reportCleanupErrors("retire", failures);
            return current.snapshot;
          }),
        );
      });

    const disposeEffect = (): Effect.Effect<void, PluginRuntimeCleanupError> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (disposed) return;
          disposalStarted = true;
          const previous = current.plugins;
          const failures = [...(yield* closePlugins(previous, true))];
          current = {
            generation: current.generation + 1,
            plugins: [],
            snapshot: emptySnapshot(),
          };
          disposed = true;
          if (failures.length > 0) {
            return yield* new PluginRuntimeCleanupError({
              failures: failures.map(({ error, pluginId }) => ({ cause: error, pluginId })),
            });
          }
        }),
      );

    const runTransition = <Result, Failure, Requirements>(
      operation: RuntimeOperation,
      effect: () => Effect.Effect<Result, Failure, Requirements>,
    ): Effect.Effect<Result, Failure | PluginRuntimeReentrancyError, Requirements> =>
      Effect.gen(function* () {
        const effectCallback = yield* PluginEffectCallback;
        return yield* Effect.suspend<Result, Failure | PluginRuntimeReentrancyError, Requirements>(
          () => {
            const asyncCallback = callbackContext.getStore();
            const callback =
              effectCallback?.runtime === runtimeIdentity ? effectCallback : asyncCallback;
            if (callback?.active === true) {
              return Effect.fail(
                new PluginRuntimeReentrancyError({
                  callback: callback.callback,
                  operation,
                  pluginId: callback.pluginId,
                }),
              );
            }
            return transitionSemaphore.withPermits(1)(effect());
          },
        );
      });

    const useContribution = <Value, Success, Failure, Requirements>(
      slot: string,
      id: string,
      generation: number,
      use: (value: Value) => Effect.Effect<Success, Failure, Requirements>,
    ): Effect.Effect<Success, Failure | PluginRuntimeContributionError, Requirements> =>
      runTransition("invoke", () =>
        Effect.suspend<
          Success,
          | Failure
          | PluginContributionGenerationError
          | PluginContributionNotFoundError
          | PluginRuntimeDisposedError,
          Requirements
        >(() => {
          if (disposalStarted) {
            return Effect.fail(new PluginRuntimeDisposedError({ operation: "invoke" }));
          }
          if (current.generation !== generation) {
            return Effect.fail(
              new PluginContributionGenerationError({
                actual: current.generation,
                expected: generation,
              }),
            );
          }
          for (const plugin of current.plugins) {
            const registration = (plugin.contributions.get(slot) ?? []).find(
              (candidate) => candidate.contribution.id === id,
            );
            if (registration !== undefined) {
              const contributionState: PluginEffectCallbackContext = {
                active: true,
                callback: "contribution",
                pluginId: plugin.definition.id,
                runtime: runtimeIdentity,
              };
              const contributionScheduler: Scheduler.Scheduler = {
                executionMode: baseScheduler.executionMode,
                shouldYield: (fiber) => baseScheduler.shouldYield(fiber),
                makeDispatcher: () => {
                  const dispatcher = baseScheduler.makeDispatcher();
                  return {
                    flush: () => dispatcher.flush(),
                    scheduleTask: (task, priority) =>
                      dispatcher.scheduleTask(
                        () => callbackContext.run(contributionState, task),
                        priority,
                      ),
                  };
                },
              };
              return Effect.yieldNow.pipe(
                Effect.andThen(Effect.suspend(() => use(registration.value as Value))),
                Effect.provideService(PluginEffectCallback, contributionState),
                Effect.provideService(Scheduler.Scheduler, contributionScheduler),
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    if (!(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))) {
                      contributionState.active = false;
                    }
                  }),
                ),
              );
            }
          }
          return Effect.fail(new PluginContributionNotFoundError({ id, slot }));
        }),
      );

    yield* Effect.addFinalizer(() =>
      runTransition("dispose", disposeEffect).pipe(
        Effect.catchTags({
          PluginRuntimeCleanupError: (error) =>
            reportCleanupErrors(
              "retire",
              error.failures.map(({ cause, pluginId }) => ({ error: cause, pluginId })),
            ),
          PluginRuntimeReentrancyError: () => Effect.void,
        }),
      ),
    );

    return {
      reconcile: (definitions) => {
        let desired: ReadonlyArray<PluginDefinition>;
        try {
          desired = snapshotDefinitions(definitions);
        } catch (error) {
          return Effect.die(error);
        }
        return runTransition("reconcile", () => reconcileEffect(desired));
      },
      snapshot: Effect.sync(() => current.snapshot),
      contributions: (slot) =>
        Effect.sync(() =>
          Object.freeze({
            generation: current.generation,
            entries: Object.freeze(
              current.plugins.flatMap((plugin) =>
                (plugin.contributions.get(slot) ?? []).map(
                  (registration) => registration.contribution,
                ),
              ),
            ),
          }),
        ),
      useContribution,
      dispose: runTransition("dispose", disposeEffect),
    } satisfies PluginRuntime["Service"];
  });

export const layer = (options: PluginRuntimeOptions = {}) =>
  Layer.effect(PluginRuntime, make(options));
