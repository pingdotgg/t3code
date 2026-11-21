import { createEnvironmentPluginAtoms } from "@t3tools/client-runtime/state/plugins";

import { connectionAtomRuntime } from "../connection/runtime";

export const nativePluginAtoms = createEnvironmentPluginAtoms(connectionAtomRuntime);
