import {
  canChangeThreadTeamView,
  canMemberCreateThreadInTeamView,
  canMemberReadTeamView,
  canToggleTeamThreadLock,
  resolveTeamThreadPostBlockReason,
  shouldNotifyTeamMemberForThread,
  type EnvironmentId,
  type TeamThreadPostBlockReason,
  type TeamView,
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

export type TeamThreadNotificationDecision = "allow" | "suppress" | "defer";

/**
 * Evaluates whether the current member should receive a notification for a thread
 * in a given environment, distinguishing confirmed decisions from in-flight metadata races.
 */
export function resolveTeamThreadNotificationDecision(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
  readonly latestRunId?: string | null;
  readonly threadCreatedAt?: string | null;
}): TeamThreadNotificationDecision {
  const { teamState, threadId, latestRunId, threadCreatedAt } = input;
  if (teamState === undefined || teamState === null) {
    return "defer";
  }
  if (teamState.team === null) {
    return "allow";
  }
  const attribution = teamState.attributionByThreadId.get(threadId);
  if (!attribution) {
    if (threadCreatedAt !== undefined && threadCreatedAt !== null) {
      const threadCreatedMs = Date.parse(threadCreatedAt);
      const teamCreatedMs = Date.parse(teamState.team.createdAt);
      if (
        Number.isFinite(threadCreatedMs) &&
        Number.isFinite(teamCreatedMs) &&
        threadCreatedMs >= teamCreatedMs
      ) {
        return "defer";
      }
    }
    return "allow";
  }
  const matchedTurn =
    latestRunId !== undefined && latestRunId !== null
      ? (teamState.turnAuthorByTurnId.get(latestRunId) ??
        (teamState.latestTurnByThreadId.get(threadId)?.turnId === latestRunId
          ? teamState.latestTurnByThreadId.get(threadId)
          : undefined))
      : undefined;
  const activeTurnAuthorMemberId =
    matchedTurn !== undefined && matchedTurn.threadId === threadId
      ? matchedTurn.authorMemberId
      : null;

  const allowed = shouldNotifyTeamMemberForThread({
    hasTeam: true,
    memberId: teamState.currentMember?.id ?? null,
    creatorMemberId: attribution.creatorMemberId,
    isFollowing: teamState.followedThreadIds.has(threadId),
    activeTurnAuthorMemberId,
  });
  if (allowed) {
    return "allow";
  }
  // If this completing/active run's attribution hasn't landed yet, defer until turnAttributed arrives.
  if (
    latestRunId !== undefined &&
    latestRunId !== null &&
    matchedTurn === undefined &&
    teamState.currentMember !== null
  ) {
    return "defer";
  }
  return "suppress";
}

/**
 * Evaluates whether the current member should receive a notification for a thread
 * in a given environment. Personal environments and unattributed legacy threads always notify.
 */
export function shouldNotifyForTeamThread(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
  readonly latestRunId?: string | null;
  readonly threadCreatedAt?: string | null;
}): boolean {
  return resolveTeamThreadNotificationDecision(input) === "allow";
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
      for (const threadId of state.followedThreadIds) {
        if (isTeamColleagueThread({ teamState: state, threadId })) {
          count += 1;
        }
      }
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

export function resolveTeamDefaultView(
  teamState: TeamEnvironmentState | null | undefined,
): TeamView | null {
  if (!teamState || teamState.team === null) return null;
  return (
    teamState.viewById.get(teamState.team.defaultViewId) ??
    teamState.views.find((view) => view.isDefault) ??
    null
  );
}

export function resolveTeamThreadView(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
}): TeamView | null {
  const { teamState, threadId } = input;
  if (!teamState || teamState.team === null) return null;
  const attribution = teamState.attributionByThreadId.get(threadId);
  const targetViewId = attribution?.viewId ?? teamState.team.defaultViewId;
  return teamState.viewById.get(targetViewId) ?? resolveTeamDefaultView(teamState);
}

export function isTeamThreadLocked(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
}): boolean {
  const { teamState, threadId } = input;
  if (!teamState || teamState.team === null) return false;
  return teamState.attributionByThreadId.get(threadId)?.locked === true;
}

export interface TeamThreadPostPermission {
  readonly canPost: boolean;
  readonly blockReason: Exclude<TeamThreadPostBlockReason, "ok"> | null;
}

export const TEAM_THREAD_POST_ALLOWED: TeamThreadPostPermission = {
  canPost: true,
  blockReason: null,
};

export function resolveTeamThreadPostPermission(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
}): TeamThreadPostPermission {
  const { teamState, threadId } = input;
  if (!teamState || teamState.team === null) {
    return TEAM_THREAD_POST_ALLOWED;
  }
  const member = teamState.currentMember;
  if (member === null || member.status !== "active") {
    return { canPost: false, blockReason: "no_access" };
  }
  const attribution = teamState.attributionByThreadId.get(threadId) ?? null;
  if (attribution === null) {
    // Match server semantics for pre-team legacy threads and avoid flashing read-only before attribution lands.
    return TEAM_THREAD_POST_ALLOWED;
  }
  const view = resolveTeamThreadView({ teamState, threadId });
  const reason = resolveTeamThreadPostBlockReason({
    member,
    attribution,
    view,
  });
  return reason === "ok" ? TEAM_THREAD_POST_ALLOWED : { canPost: false, blockReason: reason };
}

export function listAccessibleTeamViews(
  teamState: TeamEnvironmentState | null | undefined,
): ReadonlyArray<TeamView> {
  if (!teamState || teamState.team === null || teamState.currentMember === null) {
    return [];
  }
  const member = teamState.currentMember;
  return teamState.views.filter((view) => canMemberReadTeamView(member, view));
}

export function listCreatableTeamViews(
  teamState: TeamEnvironmentState | null | undefined,
): ReadonlyArray<TeamView> {
  if (!teamState || teamState.team === null || teamState.currentMember === null) {
    return [];
  }
  const member = teamState.currentMember;
  return teamState.views.filter((view) => canMemberCreateThreadInTeamView(member, view));
}

export function canCurrentMemberChangeThreadView(
  teamState: TeamEnvironmentState | null | undefined,
): boolean {
  if (!teamState || teamState.team === null || teamState.currentMember === null) {
    return false;
  }
  return (
    teamState.currentMember.status === "active" &&
    canChangeThreadTeamView(teamState.currentMember.role) &&
    listAccessibleTeamViews(teamState).length > 0
  );
}

export function canCurrentMemberToggleThreadLock(
  teamState: TeamEnvironmentState | null | undefined,
): boolean {
  if (!teamState || teamState.team === null || teamState.currentMember === null) {
    return false;
  }
  return (
    teamState.currentMember.status === "active" &&
    canToggleTeamThreadLock(teamState.currentMember.role)
  );
}
