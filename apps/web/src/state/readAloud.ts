import { createReadAloudEnvironmentAtoms } from "@t3tools/client-runtime/state/readAloud";

import { connectionAtomRuntime } from "../connection/runtime";

export const readAloudEnvironment = createReadAloudEnvironmentAtoms(connectionAtomRuntime);
