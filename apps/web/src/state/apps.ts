import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** Installed applications an `@` mention can hand to computer use. */
export const installedAppsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:apps:list",
  tag: WS_METHODS.appsList,
  staleTimeMs: 60_000,
  idleTtlMs: 300_000,
});
