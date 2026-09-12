import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Manual trigger for an environment's background agent session importer
 * (Claude Code / Codex history). Resolves with the importer's status at the
 * moment the run was requested; the run itself continues server-side.
 */
export const agentSessionImportAll = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:import-all",
  tag: WS_METHODS.agentSessionsImportAll,
});
