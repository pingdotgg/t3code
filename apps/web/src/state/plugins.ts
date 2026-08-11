import { createPluginEnvironmentAtoms } from "@t3tools/client-runtime/state/plugins";
import type { PluginCatalog } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";

export const pluginEnvironment = createPluginEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_PLUGIN_CATALOG: PluginCatalog = {
  pluginsDirectory: "",
  plugins: [],
  issues: [],
  sources: [],
};

export const primaryPluginCatalogResultAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (
    environmentId === null ||
    get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities.plugins !== true
  ) {
    return AsyncResult.success(EMPTY_PLUGIN_CATALOG);
  }
  return get(pluginEnvironment.catalog({ environmentId, input: {} }));
}).pipe(Atom.withLabel("web-primary-plugin-catalog"));
