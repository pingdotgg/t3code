import { createMemoryVaultEnvironmentAtoms } from "@t3tools/client-runtime/state/memoryVaults";

import { connectionAtomRuntime } from "../connection/runtime";

export const memoryVaultEnvironment = createMemoryVaultEnvironmentAtoms(connectionAtomRuntime);
