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

// Reload the plugin list on EVERY server-lifecycle event, not just
// `plugin-state-changed`. The lifecycle subscription (`subscribeServerLifecycle`)
// is transport-resilient — it re-subscribes on every environment (re)connect and
// the server replays the buffered `welcome`/`ready` snapshot to each new
// subscriber. Those replayed events are therefore the reliable "the connection is
// up now" signal. `listPlugins` itself is a plain unary request that fails hard
// (`EnvironmentRpcUnavailableError`) whenever the session is momentarily `None`,
// so the eager initial load below loses the race on a fresh mount / reconnect. If
// we only reloaded on `plugin-state-changed`, that failed initial load would never
// be retried until an install/uninstall happened to fire — leaving every plugin
// surface unregistered. Reloading on `welcome`/`ready` re-runs `listPlugins` as
// soon as the session connects, so the list self-heals. A redundant welcome+ready
// double-load returns the same list and is de-duplicated downstream by
// `keepLastKnownPluginList` + the per-environment cache.
function isPluginListRefreshLifecycleEvent(
  event: Pick<ServerLifecycleStreamEvent, "type">,
): boolean {
  return event.type === "welcome" || event.type === "ready" || event.type === "plugins";
}

export function makePluginListStream<A, E, R>(
  lifecycleEvents: Stream.Stream<ServerLifecycleStreamEvent, E, R>,
  loadPlugins: Effect.Effect<A, E, R>,
): Stream.Stream<A, E, R> {
  const reloads = lifecycleEvents.pipe(
    Stream.filter(isPluginListRefreshLifecycleEvent),
    Stream.mapEffect(() => loadPlugins),
  );
  return Stream.concat(Stream.fromEffect(loadPlugins), reloads);
}

// A failed refresh must NOT clear the plugin list. `PluginUiHost` drives the web
// route/sidebar/command registry off this list, so wiping it to empty on a
// transient `listPlugins` failure (e.g. a brief environment-connection blip)
// unregisters every plugin surface and makes plugin routes resolve to "not
// found". Carry the last successfully-loaded list forward: a `None` (failed
// refresh) keeps the previous value; only a `Some` (successful refresh) replaces
// it. Crucially, emit NOTHING until the first success — if the very first load of
// a (re-)subscribed stream fails (a blip during navigation), emitting an empty
// list would surface a real-looking `Success([])` that `resolvePluginListWithCache`
// would then cache, destroying the good last-known list. Emitting nothing instead
// leaves the result atom at its previous value / lets the persistent cache win.
export function keepLastKnownPluginList<E, R>(
  results: Stream.Stream<Option.Option<ReadonlyArray<PluginInfo>>, E, R>,
): Stream.Stream<ReadonlyArray<PluginInfo>, E, R> {
  return results.pipe(
    Stream.mapAccum(
      () => Option.none<ReadonlyArray<PluginInfo>>(),
      (previous, next) => {
        const current = Option.orElse(next, () => previous);
        return [current, Option.match(current, { onNone: () => [], onSome: (value) => [value] })];
      },
    ),
  );
}

const environmentPluginListResultAtom = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "web-plugins:list",
    tag: WS_METHODS.subscribeServerLifecycle,
    transform: (stream) => {
      const loadPlugins = listPlugins().pipe(
        Effect.map((result) => Option.some(result.plugins)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not refresh plugin list", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(Option.none<ReadonlyArray<PluginInfo>>())),
        ),
      );
      return keepLastKnownPluginList(makePluginListStream(stream, loadPlugins));
    },
  },
);

// Keep the last successfully-loaded plugin list per environment so a transient
// empty does NOT unload every plugin surface. PluginUiHost drives the web
// route/sidebar/command registry off this list; a connection blip that errors
// the lifecycle subscription can reset the underlying result atom to Initial
// (dropping the previous success `AsyncResult.value` would otherwise surface), or
// briefly flicker the environment, which — without this cache — collapses the
// list to empty and makes every plugin route resolve to "not found". A genuine
// change always arrives as a fresh SUCCESSFUL load and overwrites the cache
// (an install/uninstall that leaves zero plugins is a successful empty list, so
// it clears correctly). Keyed by environmentId; only the caller's env matters.
export function resolvePluginListWithCache<E>(
  environmentId: string,
  result: AsyncResult.AsyncResult<ReadonlyArray<PluginInfo>, E>,
  cache: Map<string, ReadonlyArray<PluginInfo>>,
): ReadonlyArray<PluginInfo> {
  const value = AsyncResult.value(result);
  if (Option.isSome(value)) {
    cache.set(environmentId, value.value);
    return value.value;
  }
  return cache.get(environmentId) ?? EMPTY_PLUGIN_LIST;
}

const lastKnownPluginListByEnvironment = new Map<string, ReadonlyArray<PluginInfo>>();

export const environmentPluginListAtom = Atom.family((environmentId: string) =>
  Atom.make((get): ReadonlyArray<PluginInfo> =>
    resolvePluginListWithCache(
      environmentId,
      get(
        environmentPluginListResultAtom({
          environmentId: environmentId as never,
          input: {},
        }),
      ),
      lastKnownPluginListByEnvironment,
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
