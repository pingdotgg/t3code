import { createPluginEnvironmentAtoms } from "@t3tools/client-runtime/state/plugins";
import { createPluginNpmEnvironmentAtoms } from "@t3tools/client-runtime/state/pluginNpm";
import { createPluginSettingsEnvironmentAtoms } from "@t3tools/client-runtime/state/pluginSettings";
import { createPluginViewEnvironmentAtoms } from "@t3tools/client-runtime/state/pluginViews";

import { connectionAtomRuntime } from "../connection/runtime";

export const pluginEnvironment = createPluginEnvironmentAtoms(connectionAtomRuntime);
export const pluginSettingsEnvironment =
  createPluginSettingsEnvironmentAtoms(connectionAtomRuntime);
export const pluginNpmEnvironment = createPluginNpmEnvironmentAtoms(connectionAtomRuntime);
/** Mobile shows no views; it reads which views a plugin offers for its details. */
export const pluginViewEnvironment = createPluginViewEnvironmentAtoms(connectionAtomRuntime);
