import {
  shouldNotifyTeamMemberForThread,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
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
 * Returns true when a thread belongs to an active team environment and was created by
 * a colleague (not the authenticated member). Follow controls only apply to these threads.
 */
export function isTeamColleagueThread(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
}): boolean {
  const { teamState, threadId } = input;
  if (!teamState || teamState.team === null || teamState.currentMember === null) {
    return false;
  }
  const attribution = teamState.attributionByThreadId.get(threadId);
  if (!attribution) {
    return false;
  }
  return attribution.creatorMemberId !== teamState.currentMember.id;
}

export function isFollowingTeamThread(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
}): boolean {
  const { teamState, threadId } = input;
  if (!teamState || teamState.team === null || teamState.currentMember === null) {
    return false;
  }
  return teamState.followedThreadIds.has(threadId);
}

/**
 * Evaluates whether the current member should receive a notification for a thread
 * in a given environment. Personal environments and unattributed threads always notify.
 */
export function shouldNotifyForTeamThread(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
  readonly latestRunId?: string | null;
}): boolean {
  const { teamState, threadId, latestRunId } = input;
  if (!teamState || teamState.team === null) {
    return true;
  }
  const attribution = teamState.attributionByThreadId.get(threadId);
  if (!attribution) {
    return true;
  }
  const latestTurn = teamState.latestTurnByThreadId.get(threadId);
  const activeTurnAuthorMemberId =
    latestTurn !== undefined &&
    latestRunId !== undefined &&
    latestRunId !== null &&
    latestTurn.turnId === latestRunId
      ? latestTurn.authorMemberId
      : null;

  return shouldNotifyTeamMemberForThread({
    hasTeam: true,
    memberId: teamState.currentMember?.id ?? null,
    creatorMemberId: attribution.creatorMemberId,
    isFollowing: teamState.followedThreadIds.has(threadId),
    activeTurnAuthorMemberId,
  });
}

/**
 * Evaluates whether a thread should appear in the sidebar given the user's
 * colleagues-thread and followed-only toggles. Personal environments and unattributed
 * legacy threads always remain visible unless `followedOnly` is active on a team env.
 */
export function shouldShowThreadInTeamFilter(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>;
  readonly showColleaguesThreads: boolean;
  readonly followedOnly?: boolean;
}): boolean {
  const teamState = input.teamStates.get(input.environmentId);
  if (!teamState || teamState.team === null || teamState.currentMember === null) {
    return !input.followedOnly;
  }
  if (input.followedOnly) {
    return teamState.followedThreadIds.has(input.threadId);
  }
  if (input.showColleaguesThreads) {
    return true;
  }
  const attribution = teamState.attributionByThreadId.get(input.threadId);
  if (!attribution) {
    return true;
  }
  return (
    attribution.creatorMemberId === teamState.currentMember.id ||
    teamState.followedThreadIds.has(input.threadId)
  );
}

export function countFollowedTeamThreads(
  teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>,
): number {
  let count = 0;
  for (const state of teamStates.values()) {
    if (state.team !== null && state.currentMember !== null) {
      count += state.followedThreadIds.size;
    }
  }
  return count;
}

export function hasActiveTeamEnvironment(
  teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>,
): boolean {
  for (const state of teamStates.values()) {
    if (state.team !== null) return true;
  }
  return false;
}
