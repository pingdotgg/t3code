import { createCloudEnvironmentAtoms } from "@t3tools/client-runtime/state/cloud-environments";

import { connectionAtomRuntime } from "../connection/runtime";

export const cloudEnvironments = createCloudEnvironmentAtoms(connectionAtomRuntime);
