import { useEffect, useRef } from "react";
import {
  agentSkillHasResources,
  isAgentSkillStub,
  mergeAgentLibraries,
  withoutAgentSkillTransportFields,
  type AgentSkill,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  agentLibraryOperationsFromPatch,
  agentLibrarySources,
  loadAgentSkills,
  missingAgentSkills,
  createAgentLibrarySyncGate,
  planAgentLibrarySync,
  runAgentLibrarySync,
  type AgentLibrarySyncIo,
} from "@t3tools/client-runtime/operations/agentLibrary";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useUpdateEnvironmentSettings } from "./useSettings";

function useAgentLibraryIo(label: string): AgentLibrarySyncIo {
  const getSkills = useAtomCommand(serverEnvironment.getAgentSkills, `${label}: load skills`);
  const replicate = useAtomCommand(serverEnvironment.updateSettings, label);
  return {
    fetchSkills: async (environmentId, skillIds) => {
      const result = await getSkills({ environmentId, input: { skillIds } });
      return result._tag === "Success" ? result.value.agentSkills : [];
    },
    replicate: async (environmentId, patch) =>
      (await replicate({ environmentId, input: { patch, replicateProfiles: true } }))._tag ===
      "Success",
  };
}

export function useAgentLibrary() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironment();
  const connected = environments.filter(
    (env) =>
      env.connection.phase === "connected" &&
      env.serverConfig?.environment.capabilities.agentLibrarySync === true,
  );
  const sources = agentLibrarySources(environments);
  const library = mergeAgentLibraries(sources.map((source) => source.library));
  const target =
    connected.find((env) => env.serverConfig?.environment.capabilities.agentLibraryMutations) ??
    connected.find((env) => env.serverConfig?.environment.capabilities.agentSkillResources) ??
    connected.find(
      (env) =>
        env.environmentId === primary?.environmentId &&
        env.serverConfig?.environment.capabilities.agentSkillsSync,
    ) ??
    connected.find((env) => env.serverConfig?.environment.capabilities.agentSkillsSync) ??
    connected[0];
  const capabilities = target?.serverConfig?.environment.capabilities;
  const persistSettings = useUpdateEnvironmentSettings(target?.environmentId ?? null);
  const io = useAgentLibraryIo("agent library sync before edit");
  const mutate = useAtomCommand(serverEnvironment.mutateAgentLibrary, "agent library edit");
  /** Full skills, bodies included, for editing, export or reuse; unreachable ones are left out. */
  const loadSkills = (skillIds: ReadonlyArray<string>) =>
    loadAgentSkills(sources, library, skillIds, io.fetchSkills);
  const updateSettings = async (patch: ServerSettingsPatch) => {
    if (!target) return false;
    if (
      library.agentSkills.some(agentSkillHasResources) &&
      capabilities?.agentSkillResources !== true
    )
      throw new Error("Update T3 on this machine to edit skills with resources.");
    const plan = planAgentLibrarySync(sources, { targets: [target.environmentId] });
    const available = new Set(
      [
        ...(target.serverConfig?.settings.agentSkills ?? []),
        ...(plan.targets[0]?.patch.agentSkills ?? []),
        ...(patch.agentSkills ?? []),
      ].map((skill) => skill.skillId),
    );
    const missing = new Set(
      (patch.mcpGatewayProfiles ?? []).flatMap((profile) => {
        const seen = library.mcpGatewayProfiles.find(
          (item) => item.profileId === profile.profileId,
        );
        return seen === profile ? [] : missingAgentSkills(library, profile, available);
      }),
    );
    if (missing.size > 0)
      throw new Error(
        `Connect the machine that holds ${[...missing].map((name) => `"${name}"`).join(", ")}, then save again.`,
      );
    if (!(await runAgentLibrarySync(plan, io))) return false;
    if (capabilities?.agentLibraryLastWriteWins === true) {
      const { operations, rest } = agentLibraryOperationsFromPatch(library, patch);
      if (operations.length > 0) {
        const result = await mutate({ environmentId: target.environmentId, input: { operations } });
        if (result._tag !== "Success") return false;
      }
      return Object.keys(rest).length === 0 || persistSettings(rest);
    }
    // Older servers store whatever they receive, so stubs from newer machines get their bodies first.
    if (patch.agentSkills?.some(isAgentSkillStub)) {
      const stubs = patch.agentSkills.filter(isAgentSkillStub);
      const loaded = await loadSkills(stubs.map((skill) => skill.skillId));
      if (loaded.length < stubs.length)
        throw new Error("Connect the machine that holds these skills, then save again.");
      const agentSkills = patch.agentSkills.map((skill): AgentSkill => {
        const full = loaded.find((item) => item.skillId === skill.skillId);
        if (!isAgentSkillStub(skill) || !full) return skill;
        return {
          ...withoutAgentSkillTransportFields(skill),
          content: full.content,
          ...(full.resources ? { resources: full.resources } : {}),
        };
      });
      return persistSettings({ ...patch, agentSkills });
    }
    return persistSettings(patch);
  };
  return {
    skillsAvailable: capabilities?.agentSkillsSync === true,
    skillResourcesAvailable: capabilities?.agentSkillResources === true,
    skills: library.agentSkills,
    profiles: library.mcpGatewayProfiles,
    available: !!target,
    updateSettings,
    loadSkills,
  };
}

/** A connected client bridges its machines. */
export function AgentLibrarySync() {
  const { environments } = useEnvironments();
  const io = useAgentLibraryIo("agent library sync");
  const gate = useRef(createAgentLibrarySyncGate());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replicates the merged agent library to connected servers when their streamed settings change
  useEffect(() => {
    const sources = agentLibrarySources(environments);
    const plan = planAgentLibrarySync(sources);
    const batch = gate.current.take(plan, sources);
    if (batch.targets.length === 0) return;
    void runAgentLibrarySync({ ...plan, targets: batch.targets }, io).then(
      (accepted) => batch.settle(accepted),
      () => batch.settle(false),
    );
  }, [environments, io]);
  return null;
}
