import { createLinearEnvironmentAtoms } from "@t3tools/client-runtime/state/linear";

import { connectionAtomRuntime } from "../connection/runtime";

export const linearEnvironment = createLinearEnvironmentAtoms(connectionAtomRuntime);
