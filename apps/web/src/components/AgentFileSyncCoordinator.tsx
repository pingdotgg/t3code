import { useEffect } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { agentFileSync, startAgentFileSyncRelay } from "../state/agentFileSync";
import { useEnvironments } from "../state/environments";

export function AgentFileSyncCoordinator() {
  const { environments } = useEnvironments();
  const key = environments
    .filter(
      (env) =>
        env.connection.phase === "connected" &&
        env.serverConfig?.environment.capabilities.agentFileSync,
    )
    .map((env) => env.environmentId)
    .sort()
    .join(",");
  useEffect(
    () =>
      startAgentFileSyncRelay(
        appAtomRegistry,
        agentFileSync,
        key ? key.split(",").map((id) => EnvironmentId.make(id)) : [],
      ),
    [key],
  );
  return null;
}
