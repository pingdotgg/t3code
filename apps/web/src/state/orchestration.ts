import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import { createOrchestrationEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const orchestrationEnvironment = createOrchestrationEnvironmentAtoms(connectionAtomRuntime);

/** One fresh read of a thread, for checking it still exists before opening it. */
export const threadProjectionRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:orchestration-v2:thread-projection-read",
  tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
});
