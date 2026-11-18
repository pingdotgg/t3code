import { useEffect, useRef } from "react";
import { mergeAgentLibraries, type AgentSkill } from "@t3tools/contracts";
import {
  agentLibrarySources,
  loadAgentSkills,
  computerGrounderSources,
  createAgentLibrarySyncGate,
  createComputerGrounderSyncGate,
  planAgentLibrarySync,
  planComputerGrounderSync,
  runAgentLibrarySync,
  runComputerGrounderSync,
  type AgentLibrarySyncIo,
  type ComputerGrounderSyncIo,
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

function useComputerGrounderIo(): ComputerGrounderSyncIo {
  const reveal = useAtomCommand(
    serverEnvironment.revealComputerGrounderKey,
    "decision endpoint sync: read key",
  );
  const replicate = useAtomCommand(serverEnvironment.updateSettings, "decision endpoint sync");
  return {
    revealKey: async (environmentId) => {
      const result = await reveal({ environmentId, input: {} });
      return result._tag === "Success" ? result.value.apiKey : undefined;
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
  const grounderIo = useComputerGrounderIo();
  const grounderGate = useRef(createComputerGrounderSyncGate());
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replicates the latest decision endpoint save to connected servers when their streamed settings change
  useEffect(() => {
    const plan = planComputerGrounderSync(computerGrounderSources(environments));
    const batch = grounderGate.current.take(plan);
    if (batch.targets.length === 0) return;
    void runComputerGrounderSync({ ...plan, targets: batch.targets }, grounderIo).then(
      (accepted) => batch.settle(accepted),
      () => batch.settle(false),
    );
  }, [environments, grounderIo]);
  return null;
}
