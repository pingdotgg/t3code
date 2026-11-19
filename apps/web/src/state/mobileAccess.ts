import { createMobileAccessEnvironmentAtoms } from "@t3tools/client-runtime/state/mobileAccess";

import { connectionAtomRuntime } from "../connection/runtime";

export const mobileAccessEnvironment = createMobileAccessEnvironmentAtoms(connectionAtomRuntime);
