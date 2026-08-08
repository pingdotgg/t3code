import type { AgentProfileRef } from "@t3tools/contracts";

export function resolveAgentProfileSelection(
  draftAgentProfile: AgentProfileRef | null | undefined,
  threadAgentProfile: AgentProfileRef | null | undefined,
): AgentProfileRef | null {
  return draftAgentProfile === undefined ? (threadAgentProfile ?? null) : draftAgentProfile;
}
