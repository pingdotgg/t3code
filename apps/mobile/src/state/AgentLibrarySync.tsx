import { useEffect, useRef } from "react";
import { agentLibraryForSync, mergeAgentLibraries } from "@t3tools/contracts";
import { useEnvironments } from "./environments";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

/** A connected client bridges the agent library across its machines. */
export function AgentLibrarySync() {
  const { environments } = useEnvironments();
  const update = useAtomCommand(serverEnvironment.updateSettings, "agent library sync");
  const pending = useRef(new Set<string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replicates the merged agent library to connected environment servers through RPC
  useEffect(() => {
    const connected = environments.filter(
      (env) =>
        env.connection.phase === "connected" &&
        env.serverConfig?.environment.capabilities.agentLibrarySync === true,
    );
    const library = mergeAgentLibraries(
      environments.flatMap((env) =>
        env.serverConfig?.environment.capabilities.agentLibrarySync
          ? [env.serverConfig.settings]
          : [],
      ),
    );
    for (const env of connected) {
      if (
        library.agentSkills.some((skill) => skill.resources?.length) &&
        env.serverConfig!.environment.capabilities.agentSkillResources !== true
      )
        continue;
      const supportsSkills = env.serverConfig!.environment.capabilities.agentSkillsSync === true;
      const patch = agentLibraryForSync(library, supportsSkills);
      const serialized = JSON.stringify(patch);
      if (
        JSON.stringify(
          agentLibraryForSync(mergeAgentLibraries([env.serverConfig!.settings]), supportsSkills),
        ) === serialized
      )
        continue;
      const environmentId = env.environmentId;
      const key = `${environmentId}:${serialized}`;
      if (pending.current.has(key)) continue;
      pending.current.add(key);
      void update({ environmentId, input: { patch, replicateProfiles: true } }).finally(() =>
        pending.current.delete(key),
      );
    }
  }, [environments, update]);
  return null;
}
