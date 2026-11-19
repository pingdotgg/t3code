import { createImproveEnvironmentAtoms } from "@t3tools/client-runtime/state/improve";

import { connectionAtomRuntime } from "../connection/runtime";

export const improveEnvironment = createImproveEnvironmentAtoms(connectionAtomRuntime);
