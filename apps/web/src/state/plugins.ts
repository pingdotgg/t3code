import { createPluginEnvironmentAtoms } from "@t3tools/client-runtime/state/plugins";
import { createPluginNpmEnvironmentAtoms } from "@t3tools/client-runtime/state/pluginNpm";
import { createPluginSettingsEnvironmentAtoms } from "@t3tools/client-runtime/state/pluginSettings";

import { connectionAtomRuntime } from "../connection/runtime";

export const pluginEnvironment = createPluginEnvironmentAtoms(connectionAtomRuntime);
export const pluginSettingsEnvironment =
  createPluginSettingsEnvironmentAtoms(connectionAtomRuntime);
export const pluginNpmEnvironment = createPluginNpmEnvironmentAtoms(connectionAtomRuntime);
