import { WS_METHODS } from "@t3tools/contracts";
import { createDirectPushCommands } from "@t3tools/client-runtime/state/directPush";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const directPushEnvironment = createDirectPushCommands(connectionAtomRuntime);

/** The environment's APNs key and registered phones, read again each time the row opens. */
export const directPushStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:direct-push:status",
  tag: WS_METHODS.directPushGetStatus,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
