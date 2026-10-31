import { createTailnetEnvironmentAtoms } from "@t3tools/client-runtime/state/tailnet";

import { connectionAtomRuntime } from "../connection/runtime";

export const tailnetEnvironment = createTailnetEnvironmentAtoms(connectionAtomRuntime);
