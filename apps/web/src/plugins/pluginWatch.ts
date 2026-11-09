import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { pluginEnvironment } from "../state/plugins";
import { pluginUiEnvironmentsAtom, rememberDrawsPlugins } from "./pluginFollow";

const isPluginOn = (plugin: PluginState) => plugin.enabled && plugin.status === "active";

export const isLoadableWebPlugin = (plugin: PluginState) => plugin.hasWeb && isPluginOn(plugin);

export const hasLoadableStyles = (plugin: PluginState) =>
  plugin.styles !== undefined && plugin.styles.length > 0 && isPluginOn(plugin);

// Calls `onFound` once. The runtimes follow the same atom, so they open no second stream.
export function watchForPlugins(
  environmentId: EnvironmentId,
  wanted: (plugin: PluginState) => boolean,
  onFound: () => void,
): () => void {
  let found = false;
  return appAtomRegistry.subscribe(
    pluginEnvironment.pluginsLive({ environmentId, input: {} }),
    (result) => {
      if (found || !AsyncResult.isSuccess(result)) return;
      if (!result.value.plugins.some(wanted)) return;
      found = true;
      onFound();
    },
    { immediate: true },
  );
}

export const rememberDrawingPlugins = (environmentId: EnvironmentId) =>
  appAtomRegistry.subscribe(
    pluginEnvironment.pluginsLive({ environmentId, input: {} }),
    (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      rememberDrawsPlugins(
        environmentId,
        result.value.plugins.some(
          (plugin) => isLoadableWebPlugin(plugin) || hasLoadableStyles(plugin),
        ),
      );
    },
    { immediate: true },
  );

// App-wide contributions, such as commands and styles, have no thread to tie them to an
// environment, so a plugin on in several chosen environments takes them from the first. An
// environment whose list has not arrived claims nothing yet.
const appWideEnvironmentsAtom = Atom.make((get) => {
  const owners = new Map<PluginState["id"], EnvironmentId>();
  for (const environmentId of get(pluginUiEnvironmentsAtom)) {
    const result = get(pluginEnvironment.pluginsLive({ environmentId, input: {} }));
    if (!AsyncResult.isSuccess(result)) continue;
    for (const plugin of result.value.plugins) {
      if (isPluginOn(plugin) && !owners.has(plugin.id)) owners.set(plugin.id, environmentId);
    }
  }
  return owners;
});

/** `appWide` says whether a plugin's app-wide contributions come from this environment. */
export function followPlugins(
  environmentId: EnvironmentId,
  onChange: (
    plugins: ReadonlyArray<PluginState>,
    appWide: (pluginId: PluginState["id"]) => boolean,
  ) => void,
): () => void {
  const latest = Atom.make((get) => {
    const result = get(pluginEnvironment.pluginsLive({ environmentId, input: {} }));
    return AsyncResult.isSuccess(result)
      ? { plugins: result.value.plugins, owners: get(appWideEnvironmentsAtom) }
      : undefined;
  });
  return appAtomRegistry.subscribe(
    latest,
    (value) => {
      if (value !== undefined) {
        onChange(value.plugins, (pluginId) => value.owners.get(pluginId) === environmentId);
      }
    },
    { immediate: true },
  );
}
