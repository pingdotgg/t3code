import * as NodeAsyncHooks from "node:async_hooks";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

import type {
  Contribution,
  PluginActivationContext,
  PluginDefinition,
  PluginRuntimeOptions,
  PluginRuntimeSnapshot,
} from "./contract.ts";
import {
  affectedPluginIds,
  isPluginPlanningError,
  planComposition,
  type PluginPlanningError,
} from "./planner.ts";

interface LivePlugin {
  readonly definition: PluginDefinition;
  readonly scope: Scope.Closeable;
  readonly contributions: ReadonlyMap<string, ReadonlyArray<Contribution>>;
  readonly cleanupErrors: Array<unknown>;
}

interface LiveComposition {
  readonly plugins: ReadonlyArray<LivePlugin>;
  readonly snapshot: PluginRuntimeSnapshot;
}

type RuntimeOperation = "reconcile" | "dispose";
type PluginCallback = "activate" | "finalizer";

interface PluginCallbackContext {
  active: boolean;
  readonly callback: PluginCallback;
  readonly pluginId: string;
}

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

class PluginRuntimeDisposedError extends Schema.TaggedErrorClass<PluginRuntimeDisposedError>()(
  "PluginRuntimeDisposedError",
  { operation: Schema.Literals(["reconcile", "dispose"]) },
) {
  override get message(): string {
    return `Plugin runtime is disposed; cannot ${this.operation}`;
  }
}

class PluginRuntimeReentrancyError extends Schema.TaggedErrorClass<PluginRuntimeReentrancyError>()(
  "PluginRuntimeReentrancyError",
  {
    callback: Schema.Literals(["activate", "finalizer"]),
    operation: Schema.Literals(["reconcile", "dispose"]),
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
  | PluginRuntimeDisposedError
  | PluginRuntimeReentrancyError
  | PluginStagingError;

export type PluginRuntimeDisposeError = PluginRuntimeCleanupError | PluginRuntimeReentrancyError;

export class PluginRuntime extends Context.Service<
  PluginRuntime,
  {
    readonly reconcile: (
      definitions: ReadonlyArray<PluginDefinition>,
    ) => Effect.Effect<PluginRuntimeSnapshot, PluginRuntimeReconcileError>;
    readonly snapshot: Effect.Effect<PluginRuntimeSnapshot>;
    readonly dispose: Effect.Effect<void, PluginRuntimeDisposeError>;
  }
>()("@t3tools/plugin-runtime/runtime/PluginRuntime") {}

const createNullPrototypeRecord = <Value>(): Record<string, Value> =>
  Object.create(null) as Record<string, Value>;

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
        ...registrations.map((registration) =>
          Object.freeze({ id: registration.id, label: registration.label }),
        ),
      ]);
    }
  }
  return Object.freeze({
    active: Object.freeze(plugins.map((plugin) => plugin.definition.id)),
    blocked: Object.freeze(Object.assign(createNullPrototypeRecord<string>(), blocked)),
    contributions: Object.freeze(contributions),
  });
};

export const make = (options: PluginRuntimeOptions = {}) =>
  Effect.gen(function* () {
    const parentScope = yield* Effect.scope;
    const transitionSemaphore = yield* Semaphore.make(1);
    let current: LiveComposition = { plugins: [], snapshot: emptySnapshot() };
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
      callback: PluginCallback,
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
          const contributions = new Map<string, Array<Contribution>>();
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
            register: (slot, contribution) => {
              assertActivating("register");
              const values = contributions.get(slot) ?? [];
              values.push(Object.freeze({ id: contribution.id, label: contribution.label }));
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
                  return {
                    plugins: nextPlugins,
                    snapshot: snapshotOf(nextPlugins, plan.blocked),
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
          current = { plugins: [], snapshot: emptySnapshot() };
          disposed = true;
          if (failures.length > 0) {
            return yield* new PluginRuntimeCleanupError({
              failures: failures.map(({ error, pluginId }) => ({ cause: error, pluginId })),
            });
          }
        }),
      );

    const runTransition = <Result, Failure>(
      operation: RuntimeOperation,
      effect: () => Effect.Effect<Result, Failure>,
    ): Effect.Effect<Result, Failure | PluginRuntimeReentrancyError> =>
      Effect.suspend<Result, Failure | PluginRuntimeReentrancyError, never>(() => {
        const callback = callbackContext.getStore();
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
      });

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
      dispose: runTransition("dispose", disposeEffect),
    } satisfies PluginRuntime["Service"];
  });

export const layer = (options: PluginRuntimeOptions = {}) =>
  Layer.effect(PluginRuntime, make(options));
