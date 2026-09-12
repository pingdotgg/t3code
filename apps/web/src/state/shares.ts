import { createShareEnvironmentAtoms } from "@t3tools/client-runtime/state/shares";

import { connectionAtomRuntime } from "../connection/runtime";

export const shareEnvironment = createShareEnvironmentAtoms(connectionAtomRuntime);
