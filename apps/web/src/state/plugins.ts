import { createPluginEnvironmentAtoms } from "@t3tools/client-runtime/state/plugins";

import { connectionAtomRuntime } from "../connection/runtime";

export const pluginEnvironment = createPluginEnvironmentAtoms(connectionAtomRuntime);
