import { useEffect, useRef } from "react";
import {
  agentLibraryForSync,
  mergeAgentLibraries,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
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
  const library = mergeAgentLibraries(
    environments.flatMap((env) => (env.serverConfig ? [env.serverConfig.settings] : [])),
  );
  const target =
    connected.find((env) => env.serverConfig?.environment.capabilities.agentSkillResources) ??
    connected.find(
      (env) =>
        env.environmentId === primary?.environmentId &&
        env.serverConfig?.environment.capabilities.agentSkillsSync,
    ) ??
    connected.find((env) => env.serverConfig?.environment.capabilities.agentSkillsSync) ??
    connected[0];
  const persistSettings = useUpdateEnvironmentSettings(target?.environmentId ?? null);
  const replicate = useAtomCommand(
    serverEnvironment.updateSettings,
    "agent library sync before edit",
  );
  const updateSettings = async (patch: ServerSettingsPatch) => {
    if (!target) return false;
    if (
      library.agentSkills.some((skill) => skill.resources?.length) &&
      target.serverConfig?.environment.capabilities.agentSkillResources !== true
    )
      throw new Error("Update T3 on this machine to edit skills with resources.");
    const synced = await replicate({
      environmentId: target.environmentId,
      input: {
        patch: agentLibraryForSync(
          library,
          target.serverConfig?.environment.capabilities.agentSkillsSync === true,
        ),
        replicateProfiles: true,
      },
    });
    if (synced._tag !== "Success") return false;
    return persistSettings(patch);
  };
  return {
    skillsAvailable: target?.serverConfig?.environment.capabilities.agentSkillsSync === true,
    skillResourcesAvailable:
      target?.serverConfig?.environment.capabilities.agentSkillResources === true,
    skills: library.agentSkills,
    profiles: library.mcpGatewayProfiles,
    available: !!target,
    updateSettings,
  };
}

/** A connected client bridges its machines. */
export function AgentLibrarySync() {
  const { environments } = useEnvironments();
  const update = useAtomCommand(serverEnvironment.updateSettings, "agent library sync");
  const pending = useRef(new Set<string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replicates the merged agent library to connected servers when their streamed settings change
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
