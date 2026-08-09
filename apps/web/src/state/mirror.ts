import { createMirrorEnvironmentAtoms } from "@t3tools/client-runtime/state/mirror";

import { connectionAtomRuntime } from "../connection/runtime";

export const mirrorEnvironment = createMirrorEnvironmentAtoms(connectionAtomRuntime);
