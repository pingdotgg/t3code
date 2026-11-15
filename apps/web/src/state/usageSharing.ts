import { createUsageSharingEnvironmentAtoms } from "@t3tools/client-runtime/state/usageSharing";

import { connectionAtomRuntime } from "../connection/runtime";

export const usageSharingEnvironment = createUsageSharingEnvironmentAtoms(connectionAtomRuntime);
