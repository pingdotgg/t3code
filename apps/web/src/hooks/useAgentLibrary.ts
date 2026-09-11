import { useEffect, useMemo, useRef } from "react";
import { mergeAgentLibraries } from "@t3tools/contracts";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useUpdateEnvironmentSettings } from "./useSettings";

export function useAgentLibrary() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironment();
  const connected = environments.filter(
    (env) =>
      env.connection.phase === "connected" &&
      env.serverConfig?.environment.capabilities.agentLibrarySync === true,
  );
  const library = useMemo(
    () =>
      mergeAgentLibraries(
        environments.flatMap((env) => (env.serverConfig ? [env.serverConfig.settings] : [])),
      ),
    [environments],
  );
  const target =
    connected.find((env) => env.environmentId === primary?.environmentId) ?? connected[0];
  const updateSettings = useUpdateEnvironmentSettings(target?.environmentId ?? null);
  return { profiles: library.mcpGatewayProfiles, available: !!target, updateSettings };
}

/** A connected client bridges its machines, including peers reached through T3 Connect. */
export function AgentLibrarySync() {
  const { environments } = useEnvironments();
  const update = useAtomCommand(serverEnvironment.updateSettings, "agent library sync");
  const pending = useRef(new Set<string>());
  useEffect(() => {
    const connected = environments.filter(
      (env) =>
        env.connection.phase === "connected" &&
        env.serverConfig?.environment.capabilities.agentLibrarySync === true,
    );
    const library = mergeAgentLibraries(connected.map((env) => env.serverConfig!.settings));
    const serialized = JSON.stringify(library);
    const targets = connected
      .filter(
        (env) => JSON.stringify(mergeAgentLibraries([env.serverConfig!.settings])) !== serialized,
      )
      .map((env) => env.environmentId);
    for (const environmentId of targets) {
      const key = `${environmentId}:${serialized}`;
      if (pending.current.has(key)) continue;
      pending.current.add(key);
      void update({ environmentId, input: { patch: library, replicateProfiles: true } }).finally(
        () => pending.current.delete(key),
      );
    }
  }, [environments, update]);
  return null;
}
