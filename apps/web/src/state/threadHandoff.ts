import { createThreadHandoffEnvironmentAtoms } from "@t3tools/client-runtime/state/peerLinks";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadHandoffEnvironment = createThreadHandoffEnvironmentAtoms(connectionAtomRuntime);
