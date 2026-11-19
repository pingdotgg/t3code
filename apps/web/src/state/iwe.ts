import { createIweEnvironmentAtoms } from "@t3tools/client-runtime/state/iwe";

import { connectionAtomRuntime } from "../connection/runtime";

export const iweEnvironment = createIweEnvironmentAtoms(connectionAtomRuntime);
