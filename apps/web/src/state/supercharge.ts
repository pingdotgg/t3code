import { createSuperchargeEnvironmentAtoms } from "@t3tools/client-runtime/state/supercharge";

import { connectionAtomRuntime } from "../connection/runtime";

export const superchargeEnvironment = createSuperchargeEnvironmentAtoms(connectionAtomRuntime);
