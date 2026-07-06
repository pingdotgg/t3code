import {
  type PluginCatalogInput,
  type PluginId,
  type PluginInfo,
  type PluginInstallBeginInput,
  type PluginInstallConfirmInput,
  type PluginSetEnabledInput,
  type PluginSourcesAddInput,
  type PluginSourcesRemoveInput,
  type PluginUninstallInput,
  type PluginUpgradeBeginInput,
  type PluginUpgradeConfirmInput,
  type ServerLifecycleStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  abortPluginInstall,
  addPluginSource,
  beginPluginInstall,
  beginPluginUpgrade,
  callPlugin,
  checkPluginUpdates,
  confirmPluginInstall,
  confirmPluginUpgrade,
  getPluginCatalog,
  listPluginSources,
  listPlugins,
  removePluginSource,
  setPluginEnabled,
  subscribePlugin,
  uninstallPlugin,
} from "@t3tools/client-runtime/rpc";
import {
  createRuntimeCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  executeAtomQuery,
  runInEnvironment,
  runStreamInEnvironment,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { isPluginStateChangedLifecycleEvent } from "@t3tools/client-runtime/state/server";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

const EMPTY_PLUGIN_LIST: ReadonlyArray<PluginInfo> = Object.freeze([]);

export class PluginManagementConnectionError extends Error {
  override readonly name = "PluginManagementConnectionError";

  constructor() {
    super("Plugin management is unavailable before the primary environment is connected.");
  }
}

function runPrimaryPluginManagement<A, E, R>(
  registry: AtomRegistry.AtomRegistry,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const environmentId = registry.get(primaryEnvironmentIdAtom);
    if (environmentId === null) {
      return yield* Effect.fail(new PluginManagementConnectionError());
    }
    return yield* runInEnvironment(environmentId as never, effect);
  });
}

export function makePluginListStream<E, R>(
  lifecycleEvents: Stream.Stream<ServerLifecycleStreamEvent, E, R>,
  loadPlugins: Effect.Effect<ReadonlyArray<PluginInfo>, E, R>,
): Stream.Stream<ReadonlyArray<PluginInfo>, E, R> {
  const reloads = lifecycleEvents.pipe(
    Stream.filter(isPluginStateChangedLifecycleEvent),
    Stream.mapEffect(() => loadPlugins),
  );
  return Stream.concat(Stream.fromEffect(loadPlugins), reloads);
}

const environmentPluginListResultAtom = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "web-plugins:list",
    tag: WS_METHODS.subscribeServerLifecycle,
    transform: (stream) => {
      const loadPlugins = listPlugins().pipe(
        Effect.map((result) => result.plugins),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not refresh plugin list", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(EMPTY_PLUGIN_LIST)),
        ),
      );
      return makePluginListStream(stream, loadPlugins);
    },
  },
);

export const environmentPluginListAtom = Atom.family((environmentId: string) =>
  Atom.make(
    (get): ReadonlyArray<PluginInfo> =>
      Option.getOrElse(
        AsyncResult.value(
          get(
            environmentPluginListResultAtom({
              environmentId: environmentId as never,
              input: {},
            }),
          ),
        ),
        () => EMPTY_PLUGIN_LIST,
      ),
  ).pipe(Atom.withLabel(`web-plugins:list:${environmentId}`)),
);

export const pluginListAtom = Atom.make((get): ReadonlyArray<PluginInfo> => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return EMPTY_PLUGIN_LIST;
  }
  return get(environmentPluginListAtom(environmentId));
}).pipe(Atom.withLabel("web-plugins:list"));

export interface PluginRpcDependencies {
  readonly call?: (pluginId: PluginId, method: string, payload?: unknown) => Promise<unknown>;
  readonly subscribe?: (
    pluginId: PluginId,
    method: string,
    payload?: unknown,
  ) => Stream.Stream<unknown, unknown, unknown>;
}

async function defaultPluginCall(
  pluginId: PluginId,
  method: string,
  payload?: unknown,
): Promise<unknown> {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    throw new Error("Plugin RPC is unavailable before the primary environment is connected.");
  }

  const atom = connectionAtomRuntime
    .atom(runInEnvironment(environmentId, callPlugin(pluginId, method, payload)))
    .pipe(Atom.withLabel(`web-plugins:rpc:${pluginId}:${method}`));
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    reportDefect: false,
    reportFailure: false,
  });
  if (result._tag === "Success") {
    return result.value;
  }
  throw squashAtomCommandFailure(result);
}

function defaultPluginSubscribe(
  pluginId: PluginId,
  method: string,
  payload?: unknown,
): Stream.Stream<unknown, unknown, unknown> {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return Stream.fail(
      new Error("Plugin RPC is unavailable before the primary environment is connected."),
    );
  }
  return runStreamInEnvironment(environmentId, subscribePlugin(pluginId, method, payload));
}

export function pluginRpc(pluginId: PluginId, dependencies: PluginRpcDependencies = {}) {
  const call = dependencies.call ?? defaultPluginCall;
  const subscribe = dependencies.subscribe ?? defaultPluginSubscribe;
  return {
    call: (method: string, payload?: unknown) => call(pluginId, method, payload),
    subscribe: (method: string, payload?: unknown) => subscribe(pluginId, method, payload),
  };
}

export const listPluginSourcesCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web-plugins:sources:list",
  execute: (_input: void, registry) => runPrimaryPluginManagement(registry, listPluginSources()),
});

export const addPluginSourceCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web-plugins:sources:add",
  execute: (input: PluginSourcesAddInput, registry) =>
    runPrimaryPluginManagement(registry, addPluginSource(input)),
});

export const removePluginSourceCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web-plugins:sources:remove",
  execute: (input: PluginSourcesRemoveInput, registry) =>
    runPrimaryPluginManagement(registry, removePluginSource(input)),
});

export const getPluginCatalogCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web-plugins:catalog",
  execute: (input: PluginCatalogInput | void, registry) =>
    runPrimaryPluginManagement(registry, getPluginCatalog(input ?? {})),
});

export const beginPluginInstallCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web-plugins:install:begin",
  execute: (input: PluginInstallBeginInput, registry) =>
    runPrimaryPluginManagement(registry, beginPluginInstall(input)),
});

export const confirmPluginInstallCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web-plugins:install:confirm",
  execute: (input: PluginInstallConfirmInput, registry) =>
    runPrimaryPluginManagement(registry, confirmPluginInstall(input)),
});

export const abortPluginInstallCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web-plugins:install:abort",
  execute: (input: PluginInstallConfirmInput, registry) =>
    runPrimaryPluginManagement(registry, abortPluginInstall(input)),
});

export const setPluginEnabledCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web-plugins:set-enabled",
  execute: (input: PluginSetEnabledInput, registry) =>
    runPrimaryPluginManagement(registry, setPluginEnabled(input)),
});

export const uninstallPluginCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web-plugins:uninstall",
  execute: (input: PluginUninstallInput, registry) =>
    runPrimaryPluginManagement(registry, uninstallPlugin(input)),
});

export const beginPluginUpgradeCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web-plugins:upgrade:begin",
  execute: (input: PluginUpgradeBeginInput, registry) =>
    runPrimaryPluginManagement(registry, beginPluginUpgrade(input)),
});

export const confirmPluginUpgradeCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web-plugins:upgrade:confirm",
  execute: (input: PluginUpgradeConfirmInput, registry) =>
    runPrimaryPluginManagement(registry, confirmPluginUpgrade(input)),
});

export const checkPluginUpdatesCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web-plugins:updates:check",
  execute: (_input: void, registry) => runPrimaryPluginManagement(registry, checkPluginUpdates()),
});

export { WS_METHODS };
