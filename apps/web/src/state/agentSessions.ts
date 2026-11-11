import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

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

export const agentSessionList = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:list",
  tag: WS_METHODS.agentSessionsList,
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId, input }) =>
      `${environmentId}:${input.projectId}:${input.provider ?? "claudeAgent"}`,
  },
});

export const agentSessionAdopt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:adopt",
  tag: WS_METHODS.agentSessionsAdopt,
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId, input }) =>
      `${environmentId}:${input.projectId}:${input.providerInstanceId}:${input.providerSessionId}`,
  },
});
