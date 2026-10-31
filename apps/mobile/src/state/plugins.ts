import { createPluginEnvironmentAtoms } from "@t3tools/client-runtime/state/plugins";
import { createPluginSettingsEnvironmentAtoms } from "@t3tools/client-runtime/state/pluginSettings";

import { connectionAtomRuntime } from "../connection/runtime";

export const pluginEnvironment = createPluginEnvironmentAtoms(connectionAtomRuntime);
export const pluginSettingsEnvironment =
  createPluginSettingsEnvironmentAtoms(connectionAtomRuntime);
