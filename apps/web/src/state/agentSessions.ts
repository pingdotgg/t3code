import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Scan of Claude Code / Codex home directories on an environment, surfacing
 * project candidates for the welcome wizard's import step. The scan walks the
 * filesystem server-side, so results are cached briefly and refreshed when the
 * import step remounts.
 */
export const agentSessionScan = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:scan",
  tag: WS_METHODS.agentSessionsScan,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export const agentSessionImport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:import",
  tag: WS_METHODS.agentSessionsImport,
});

export const agentSessionImportAll = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:import-all",
  tag: WS_METHODS.agentSessionsImportAll,
});

/**
 * Live status of an environment's background agent session importer. The idle
 * TTL drops the server subscription shortly after the last reader unmounts, so
 * a status row can follow a run without holding the stream open permanently.
 */
export const agentSessionImportStatus = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:agent-sessions:status",
    tag: WS_METHODS.agentSessionsSubscribeStatus,
    idleTtlMs: 60_000,
  },
);
