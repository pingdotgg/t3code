import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { TeamEnvironmentState } from "./state.ts";

export function resolveTeamThreadCreatorPseudo(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>;
}): string | null {
  const teamState = input.teamStates.get(input.environmentId);
  if (!teamState || teamState.team === null) return null;
  const attribution = teamState.attributionByThreadId.get(input.threadId);
  if (!attribution) return null;
  return teamState.memberById.get(attribution.creatorMemberId)?.pseudo ?? attribution.creatorPseudo;
}

/**
 * Formats a team thread's display title dynamically as `pseudo: <title>` without
 * mutating the persisted thread title.
 */
export function formatTeamThreadTitle(title: string, creatorPseudo: string | null): string {
  if (!creatorPseudo) return title;
  return `${creatorPseudo}: ${title}`;
}

/**
 * Evaluates whether a thread should appear in the sidebar given the user's
 * colleagues-thread visibility toggle. Personal environments and unattributed
 * legacy threads always remain visible.
 */
export function shouldShowThreadInTeamFilter(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>;
  readonly showColleaguesThreads: boolean;
}): boolean {
  const teamState = input.teamStates.get(input.environmentId);
  if (!teamState || teamState.team === null || teamState.currentMember === null) {
    return true;
  }
  if (input.showColleaguesThreads) {
    return true;
  }
  const attribution = teamState.attributionByThreadId.get(input.threadId);
  if (!attribution) {
    return true;
  }
  return attribution.creatorMemberId === teamState.currentMember.id;
}

export function hasActiveTeamEnvironment(
  teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>,
): boolean {
  for (const state of teamStates.values()) {
    if (state.team !== null) return true;
  }
  return false;
}
