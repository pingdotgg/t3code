import {
  type PluginId,
  type PluginInfo,
  type ServerLifecycleStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { callPlugin, listPlugins, subscribePlugin } from "@t3tools/client-runtime/rpc";
import {
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
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { isPluginStateChangedLifecycleEvent } from "@t3tools/client-runtime/state/server";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

const EMPTY_PLUGIN_LIST: ReadonlyArray<PluginInfo> = Object.freeze([]);

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

export { WS_METHODS };
