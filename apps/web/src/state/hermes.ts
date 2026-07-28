import { createHermesEnvironmentAtoms } from "@t3tools/client-runtime/state/hermes";

import { connectionAtomRuntime } from "../connection/runtime";

export const hermesEnvironment = createHermesEnvironmentAtoms(connectionAtomRuntime);
