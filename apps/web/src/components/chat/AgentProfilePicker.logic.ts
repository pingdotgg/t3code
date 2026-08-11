import type { AgentProfileRef, AgentProfileSummary } from "@t3tools/contracts";

export function agentProfilePickerLabel(
  selected: AgentProfileSummary | null,
  selectedValue: AgentProfileRef | null,
  isPending: boolean,
  hasCatalog: boolean,
): string {
  if (selected?.name) return selected.name;
  if (selectedValue === null) return "Choose agent";
  return isPending && !hasCatalog ? "Loading agents…" : "Unavailable agent";
}

export function selectChatAgentProfiles(
  profiles: ReadonlyArray<AgentProfileSummary>,
  selected: Pick<AgentProfileSummary, "id" | "scope"> | null,
): ReadonlyArray<AgentProfileSummary> {
  return profiles.filter(
    (profile) =>
      (profile.archivedAt === null && profile.chatSelectable) ||
      (selected !== null && profile.id === selected.id && profile.scope === selected.scope),
  );
}

export function filterAgentProfiles(
  profiles: ReadonlyArray<AgentProfileSummary>,
  query: string,
): ReadonlyArray<AgentProfileSummary> {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return profiles;

  return profiles.filter((profile) => {
    const searchText = [profile.name, profile.id, profile.scope, profile.description ?? ""]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => searchText.includes(term));
  });
}
