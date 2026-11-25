import { createSandboxAtoms } from "@t3tools/client-runtime/state/sandboxes";

import { connectionAtomRuntime } from "../connection/runtime";

export const sandboxEnvironment = createSandboxAtoms(connectionAtomRuntime);
