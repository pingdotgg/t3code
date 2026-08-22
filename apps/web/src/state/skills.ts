import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const skillEnvironment = {
  readFile: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:skills:read-file",
    tag: WS_METHODS.skillsReadFile,
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
  }),
};
