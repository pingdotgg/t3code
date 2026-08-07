import { createAgentEnvironmentAtoms } from "@t3tools/client-runtime/state/agents";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentEnvironment = createAgentEnvironmentAtoms(connectionAtomRuntime);
