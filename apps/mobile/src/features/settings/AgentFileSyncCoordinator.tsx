import { startAgentFileSyncRelay } from "@t3tools/client-runtime/state/agentFileSync";
import { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { appAtomRegistry } from "../../state/atom-registry";
import { agentFileSync } from "../../state/agentFileSync";
import { useEnvironments } from "../../state/environments";

export function AgentFileSyncCoordinator() {
  const { environments } = useEnvironments();
  const [active, setActive] = useState(AppState.currentState === "active");
  const key = environments
    .filter(
      (env) =>
        env.connection.phase === "connected" &&
        env.serverConfig?.environment.capabilities.agentFileSync,
    )
    .map((env) => env.environmentId)
    .sort()
    .join(",");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(
    () =>
      active
        ? startAgentFileSyncRelay(
            appAtomRegistry,
            agentFileSync,
            key ? key.split(",").map((id) => EnvironmentId.make(id)) : [],
          )
        : undefined,
    [active, key],
  );
  return null;
}
