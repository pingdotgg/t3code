import { useEffect, useRef } from "react";
import { mergeAgentLibraries, type AgentSkill } from "@t3tools/contracts";
import {
  agentLibrarySources,
  loadAgentSkills,
  createAgentLibrarySyncGate,
  planAgentLibrarySync,
  runAgentLibrarySync,
  type AgentLibrarySyncIo,
} from "@t3tools/client-runtime/operations/agentLibrary";
import { useEnvironments } from "./environments";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

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

/** Full skills, bodies included; connected servers stream skills without them. */
export function useLoadAgentSkills(): (
  skillIds: ReadonlyArray<string>,
) => Promise<ReadonlyArray<AgentSkill>> {
  const { environments } = useEnvironments();
  const io = useAgentLibraryIo("agent skills");
  return (skillIds) => {
    const sources = agentLibrarySources(environments);
    return loadAgentSkills(
      sources,
      mergeAgentLibraries(sources.map((source) => source.library)),
      skillIds,
      io.fetchSkills,
    );
  };
}

/** A connected client bridges the agent library across its machines. */
export function AgentLibrarySync() {
  const { environments } = useEnvironments();
  const io = useAgentLibraryIo("agent library sync");
  const gate = useRef(createAgentLibrarySyncGate());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replicates the merged agent library to connected environment servers through RPC
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
