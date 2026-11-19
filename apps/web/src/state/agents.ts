import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentRosterQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agents:list",
  tag: WS_METHODS.agentsList,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
