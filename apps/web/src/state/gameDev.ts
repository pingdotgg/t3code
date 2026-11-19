import { createGameDevEnvironmentAtoms } from "@t3tools/client-runtime/state/gameDev";

import { connectionAtomRuntime } from "../connection/runtime";

export const gameDevEnvironment = createGameDevEnvironmentAtoms(connectionAtomRuntime);
