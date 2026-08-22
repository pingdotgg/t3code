import * as NodeAsyncHooks from "node:async_hooks";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type {
  Contribution,
  PluginActivationContext,
  PluginDefinition,
  PluginRuntime,
  PluginRuntimeFactory,
  PluginRuntimeSnapshot,
} from "./contract.ts";

interface PlannedComposition {
  readonly blocked: Readonly<Record<string, string>>;
  readonly definitions: ReadonlyArray<PluginDefinition>;
}

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

class DuplicatePluginIdError extends Schema.TaggedErrorClass<DuplicatePluginIdError>()(
  "DuplicatePluginIdError",
  { pluginId: Schema.String },
) {
  override get message(): string {
    return `Duplicate plugin id: ${this.pluginId}`;
  }
}

class DuplicateCapabilityError extends Schema.TaggedErrorClass<DuplicateCapabilityError>()(
  "DuplicateCapabilityError",
  {
    capability: Schema.String,
    pluginId: Schema.String,
    previousPluginId: Schema.String,
  },
) {
  override get message(): string {
    return `Duplicate capability ${this.capability} provided by ${this.previousPluginId} and ${this.pluginId}`;
  }
}

class DependencyCycleError extends Schema.TaggedErrorClass<DependencyCycleError>()(
  "DependencyCycleError",
  { cycle: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Dependency cycle: ${this.cycle.join(" -> ")}`;
  }
}

class PluginResolutionError extends Schema.TaggedErrorClass<PluginResolutionError>()(
  "PluginResolutionError",
  { capability: Schema.String, pluginId: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} cannot resolve inactive capability: ${this.capability}`;
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

const PluginPlanningError = Schema.Union([
  DuplicatePluginIdError,
  DuplicateCapabilityError,
  DependencyCycleError,
]);
type PluginPlanningError = typeof PluginPlanningError.Type;

const isPluginPlanningError = Schema.is(PluginPlanningError);

type PluginReconcileError =
  | PluginPlanningError
  | PluginCallbackError
  | PluginRuntimeDisposedError
  | PluginStagingError;

const createNullPrototypeRecord = <Value>(): Record<string, Value> =>
  Object.create(null) as Record<string, Value>;

const emptySnapshot = (): PluginRuntimeSnapshot =>
  Object.freeze({
    active: Object.freeze([]),
    blocked: Object.freeze(createNullPrototypeRecord<string>()),
    contributions: Object.freeze(createNullPrototypeRecord<ReadonlyArray<Contribution>>()),
  });

const planComposition = (definitions: ReadonlyArray<PluginDefinition>): PlannedComposition => {
  const definitionsById = new Map<string, PluginDefinition>();
  const providersByCapability = new Map<string, PluginDefinition>();

  for (const definition of definitions) {
    if (definitionsById.has(definition.id)) {
      throw new DuplicatePluginIdError({ pluginId: definition.id });
    }
    definitionsById.set(definition.id, definition);

    for (const capability of Object.keys(definition.provides ?? {})) {
      const previous = providersByCapability.get(capability);
      if (previous !== undefined) {
        throw new DuplicateCapabilityError({
          capability,
          pluginId: definition.id,
          previousPluginId: previous.id,
        });
      }
      providersByCapability.set(capability, definition);
    }
  }

  const visitState = new Map<string, "visiting" | "visited">();
  const stack: Array<string> = [];
  const detectCycle = (definition: PluginDefinition): void => {
    const state = visitState.get(definition.id);
    if (state === "visited") return;
    if (state === "visiting") {
      const cycleStart = stack.indexOf(definition.id);
      const cycle = [...stack.slice(cycleStart), definition.id];
      throw new DependencyCycleError({ cycle });
    }

    visitState.set(definition.id, "visiting");
    stack.push(definition.id);
    for (const capability of definition.requires ?? []) {
      const provider = providersByCapability.get(capability);
      if (provider !== undefined) detectCycle(provider);
    }
    stack.pop();
    visitState.set(definition.id, "visited");
  };

  for (const definition of definitions) detectCycle(definition);

  const blocked = new Map<string, string | undefined>();
  const blockedReason = (definition: PluginDefinition): string | undefined => {
    if (blocked.has(definition.id)) return blocked.get(definition.id);

    for (const capability of definition.requires ?? []) {
      const provider = providersByCapability.get(capability);
      if (provider === undefined) {
        const reason = `Missing dependency: ${capability}`;
        blocked.set(definition.id, reason);
        return reason;
      }

      const providerReason = blockedReason(provider);
      if (providerReason !== undefined) {
        const reason = `Dependency ${capability} is blocked: ${providerReason}`;
        blocked.set(definition.id, reason);
        return reason;
      }
    }

    blocked.set(definition.id, undefined);
    return undefined;
  };

  for (const definition of definitions) blockedReason(definition);

  const ordered: Array<PluginDefinition> = [];
  const orderedIds = new Set<string>();
  const addInDependencyOrder = (definition: PluginDefinition): void => {
    if (orderedIds.has(definition.id) || blocked.get(definition.id) !== undefined) return;

    for (const capability of definition.requires ?? []) {
      const provider = providersByCapability.get(capability);
      if (provider !== undefined) addInDependencyOrder(provider);
    }

    orderedIds.add(definition.id);
    ordered.push(definition);
  };

  for (const definition of definitions) addInDependencyOrder(definition);

  const blockedRecord = createNullPrototypeRecord<string>();
  for (const definition of definitions) {
    const reason = blocked.get(definition.id);
    if (reason !== undefined) blockedRecord[definition.id] = reason;
  }

  return { blocked: blockedRecord, definitions: ordered };
};

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
};

const sameDefinition = (left: PluginDefinition, right: PluginDefinition): boolean => {
  if (
    left.id !== right.id ||
    left.version !== right.version ||
    !Object.is(left.activate, right.activate)
  ) {
    return false;
  }
  if (!sameStrings(left.requires ?? [], right.requires ?? [])) return false;

  const leftProvides = left.provides ?? {};
  const rightProvides = right.provides ?? {};
  const leftCapabilities = Object.keys(leftProvides);
  const rightCapabilities = Object.keys(rightProvides);
  return (
    leftCapabilities.length === rightCapabilities.length &&
    leftCapabilities.every(
      (capability) =>
        Object.hasOwn(rightProvides, capability) &&
        Object.is(leftProvides[capability], rightProvides[capability]),
    )
  );
};

const dependentsByPlugin = (definitions: ReadonlyArray<PluginDefinition>) => {
  const providers = new Map<string, string>();
  const dependents = new Map<string, Set<string>>();
  for (const definition of definitions) {
    for (const capability of Object.keys(definition.provides ?? {})) {
      providers.set(capability, definition.id);
    }
  }
  for (const definition of definitions) {
    for (const capability of definition.requires ?? []) {
      const providerId = providers.get(capability);
      if (providerId === undefined) continue;
      const values = dependents.get(providerId) ?? new Set<string>();
      values.add(definition.id);
      dependents.set(providerId, values);
    }
  }
  return dependents;
};

const affectedPluginIds = (
  current: ReadonlyArray<LivePlugin>,
  desired: ReadonlyArray<PluginDefinition>,
): ReadonlySet<string> => {
  const currentById = new Map(current.map((plugin) => [plugin.definition.id, plugin]));
  const desiredById = new Map(desired.map((definition) => [definition.id, definition]));
  const affected = new Set<string>();

  for (const plugin of current) {
    const next = desiredById.get(plugin.definition.id);
    if (next === undefined || !sameDefinition(plugin.definition, next)) {
      affected.add(plugin.definition.id);
    }
  }
  for (const definition of desired) {
    const previous = currentById.get(definition.id);
    if (previous === undefined || !sameDefinition(previous.definition, definition)) {
      affected.add(definition.id);
    }
  }

  const currentDependents = dependentsByPlugin(current.map((plugin) => plugin.definition));
  const desiredDependents = dependentsByPlugin(desired);
  const queue = [...affected];
  for (let index = 0; index < queue.length; index += 1) {
    const pluginId = queue[index];
    if (pluginId === undefined) continue;
    for (const dependent of [
      ...(currentDependents.get(pluginId) ?? []),
      ...(desiredDependents.get(pluginId) ?? []),
    ]) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }

  return affected;
};

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

export const createEffectScopeRuntime: PluginRuntimeFactory = (options = {}): PluginRuntime => {
  let current: LiveComposition = { plugins: [], snapshot: emptySnapshot() };
  let disposed = false;
  let transition: Promise<void> = Promise.resolve();
  let runtimeScope: Scope.Closeable | undefined;
  const callbackContext = new NodeAsyncHooks.AsyncLocalStorage<PluginCallbackContext>();

  const getRuntimeScope = (): Effect.Effect<Scope.Closeable> =>
    Effect.gen(function* () {
      if (runtimeScope === undefined) runtimeScope = yield* Scope.make("sequential");
      return runtimeScope;
    });

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
  ): Effect.Effect<Result, PluginCallbackError> =>
    Effect.tryPromise({
      try: async () => {
        const callbackState: PluginCallbackContext = { active: true, callback, pluginId };
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          callbackState.active = false;
          onSettled?.();
        };
        try {
          const result = callbackContext.run(callbackState, invoke);
          if (typeof result === "object" && result !== null && "then" in result) {
            return await Promise.resolve(result).finally(settle);
          }
          settle();
          return result;
        } catch (error) {
          settle();
          throw error;
        }
      },
      catch: (cause) => new PluginCallbackError({ callback, cause, pluginId }),
    });

  const activatePlugin = (
    definition: PluginDefinition,
    capabilities: ReadonlyMap<string, unknown>,
  ): Effect.Effect<LivePlugin, PluginCallbackError> =>
    Effect.gen(function* () {
      const parentScope = yield* getRuntimeScope();
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
          if (!capabilities.has(capability)) {
            throw new PluginResolutionError({ capability, pluginId: definition.id });
          }
          return capabilities.get(capability) as Service;
        },
        register: (slot, contribution) => {
          assertActivating("register");
          const values = contributions.get(slot) ?? [];
          values.push(contribution);
          contributions.set(slot, values);
        },
        onDispose: (finalizer) => {
          assertActivating("onDispose");
          finalizers.push(finalizer);
        },
      };

      const activationExit = yield* Effect.exit(
        invokePluginCallback(
          "activate",
          definition.id,
          () => definition.activate(context),
          () => {
            activating = false;
          },
        ),
      );
      for (const finalizer of finalizers) {
        const finalizerEffect = invokePluginCallback("finalizer", definition.id, finalizer).pipe(
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
    });

  const reconcileEffect = (
    definitions: ReadonlyArray<PluginDefinition>,
  ): Effect.Effect<PluginRuntimeSnapshot, PluginReconcileError> =>
    Effect.gen(function* () {
      if (disposed) {
        return yield* new PluginRuntimeDisposedError({ operation: "reconcile" });
      }

      const plan = yield* Effect.try({
        try: () => planComposition(definitions),
        catch: (error) => {
          if (!isPluginPlanningError(error)) throw error;
          return error;
        },
      });
      const affected = affectedPluginIds(current.plugins, plan.definitions);
      const currentById = new Map(current.plugins.map((plugin) => [plugin.definition.id, plugin]));
      const capabilities = new Map<string, unknown>();
      for (const plugin of current.plugins) {
        if (affected.has(plugin.definition.id)) continue;
        for (const [capability, service] of Object.entries(plugin.definition.provides ?? {})) {
          capabilities.set(capability, service);
        }
      }

      const staged = new Map<string, LivePlugin>();
      const stagingExit = yield* Effect.exit(
        Effect.gen(function* () {
          for (const definition of plan.definitions) {
            if (!affected.has(definition.id)) continue;
            const plugin = yield* activatePlugin(definition, capabilities);
            staged.set(definition.id, plugin);
            for (const [capability, service] of Object.entries(definition.provides ?? {})) {
              capabilities.set(capability, service);
            }
          }
        }),
      );
      if (Exit.isFailure(stagingExit)) {
        const failures = yield* closePlugins([...staged.values()], false);
        yield* reportCleanupErrors("rollback", failures);
        return yield* Effect.failCause(stagingExit.cause);
      }

      const nextPlugins: Array<LivePlugin> = [];
      for (const definition of plan.definitions) {
        const plugin = staged.get(definition.id) ?? currentById.get(definition.id);
        if (plugin === undefined) {
          return yield* new PluginStagingError({ pluginId: definition.id });
        }
        nextPlugins.push(plugin);
      }
      const previous = current.plugins.filter((plugin) => affected.has(plugin.definition.id));
      current = {
        plugins: nextPlugins,
        snapshot: snapshotOf(nextPlugins, plan.blocked),
      };
      for (const plugin of staged.values()) {
        yield* reportLifecycle("activate", plugin.definition.id);
      }
      const failures = yield* closePlugins(previous, true);
      yield* reportCleanupErrors("retire", failures);
      return current.snapshot;
    });

  const disposeEffect = (): Effect.Effect<void, PluginRuntimeCleanupError> =>
    Effect.gen(function* () {
      if (disposed) return;
      disposed = true;
      const previous = current.plugins;
      current = { plugins: [], snapshot: emptySnapshot() };
      const failures = [...(yield* closePlugins(previous, true))];
      const parentScope = runtimeScope;
      runtimeScope = undefined;
      if (parentScope !== undefined) {
        const closeExit = yield* Effect.exit(Scope.close(parentScope, Exit.void));
        if (Exit.isFailure(closeExit)) {
          failures.push({ error: Cause.squash(closeExit.cause), pluginId: "plugin-runtime" });
        }
      }
      if (failures.length > 0) {
        return yield* new PluginRuntimeCleanupError({
          failures: failures.map(({ error, pluginId }) => ({ cause: error, pluginId })),
        });
      }
    });

  const runPromiseAdapter = <Result, Failure>(
    operation: RuntimeOperation,
    effect: () => Effect.Effect<Result, Failure>,
  ): Promise<Result> => {
    const callback = callbackContext.getStore();
    if (callback?.active === true) {
      return Promise.reject(
        new PluginRuntimeReentrancyError({
          callback: callback.callback,
          operation,
          pluginId: callback.pluginId,
        }),
      );
    }

    const result = transition.then(() => Effect.runPromise(effect()));
    transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    reconcile: (definitions) => {
      const desired = [...definitions];
      return runPromiseAdapter("reconcile", () => reconcileEffect(desired));
    },
    snapshot: () => current.snapshot,
    dispose: () => runPromiseAdapter("dispose", disposeEffect),
  };
};
