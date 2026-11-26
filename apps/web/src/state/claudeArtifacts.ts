import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

// Fork: claude.ai Artifacts across the environment's Claude accounts.
export const claudeArtifactsEnvironment = {
  /** The server's cached lists; reading never starts a fetch. */
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:claude-artifacts:list",
    tag: WS_METHODS.claudeArtifactsList,
    staleTimeMs: 60_000,
    idleTtlMs: 10 * 60_000,
  }),
  refresh: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:claude-artifacts:refresh",
    tag: WS_METHODS.claudeArtifactsRefresh,
  }),
};
