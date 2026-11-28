import {
  canChangeThreadTeamView,
  canManagePrivilegedTeamScheduledTasks,
  canManageTeamScheduledTasks,
  canMemberAccessTeamEnvironment,
  canMemberCreateThreadInTeamView,
  canMemberInterruptTeamTurn,
  canMemberLeaveTeamThreadNote,
  canMemberManageTeamQueuedRun,
  canMemberMutateTeamScheduledTask,
  canMemberPromoteTeamQueuedRun,
  canMemberReadTeamView,
  canMemberRespondToTeamRuntimeRequest,
  canMemberSteerActiveTeamTurn,
  canToggleTeamThreadLock,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEAM_NOTIFICATION_SOUND,
  isTeamAdminRole,
  isTeamOwnedThreadAttribution,
  TEAM_SCHEDULED_THREAD_PREFIX,
  isTeamProviderInstanceId,
  isTeamProviderInstanceIdForTeam,
  parseTeamProviderInstanceId,
  resolveTeamThreadEnvironmentAccess,
  resolveTeamThreadPostBlockReason,
  shouldNotifyTeamMemberForThread,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type RepositoryIdentity,
  type ScheduledTaskId,
  type ServerConfig,
  type ServerProvider,
  type TeamEnvironment,
  type TeamId,
  type TeamMemberId,
  type TeamNotificationSoundPreset,
  type TeamProjectAssignment,
  type TeamProvider,
  type TeamScheduledTaskMeta,
  type TeamThreadAttribution,
  type TeamThreadEnvironmentAccess,
  type TeamThreadNote,
  type TeamThreadPostBlockReason,
  type TeamTurnAuthorKind,
  type TeamView,
  type TeamWorkspace,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import type { TeamEnvironmentState } from "./state.ts";

export function resolveTeamThreadCreatorPseudo(
  input:
    | {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
        readonly teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>;
      }
    | {
        readonly teamState: TeamEnvironmentState | null | undefined;
        readonly threadId: ThreadId;
      },
): string | null {
  const teamState =
    "teamState" in input
      ? input.teamState
      : (resolveCorrelatedLocalSyncedTeamThread(input)?.teamState ??
        input.teamStates.get(input.environmentId));
  if (!teamState || teamState.team === null) return null;
  const attribution = teamState.attributionByThreadId.get(input.threadId);
  if (!attribution) return null;
  if (isTeamOwnedThreadAttribution(attribution) || attribution.creatorMemberId === null) {
    return TEAM_SCHEDULED_THREAD_PREFIX;
  }
  return teamState.memberById.get(attribution.creatorMemberId)?.pseudo ?? attribution.creatorPseudo;
}

export function isTeamOwnedThread(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
}): boolean {
  const { teamState, threadId } = input;
  if (!teamState || teamState.team === null) return false;
  const attribution = teamState.attributionByThreadId.get(threadId);
  return attribution !== undefined && isTeamOwnedThreadAttribution(attribution);
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
  if (!teamState || teamState.team === null || teamState.currentMember?.status !== "active") {
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
    ownerKind: attribution.ownerKind ?? (attribution.creatorMemberId === null ? "team" : "member"),
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
  const direct = input.teamStates.get(input.environmentId);
  const teamState = direct?.team
    ? direct
    : resolveCorrelatedLocalSyncedTeamThread(input)?.teamState;
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

function resolveTurnAttribution(input: {
  readonly teamState: TeamEnvironmentState;
  readonly threadId: ThreadId;
  readonly runId?: string | null | undefined;
  readonly userMessageId?: string | null | undefined;
}) {
  const { teamState, threadId, runId, userMessageId } = input;
  if (runId !== undefined && runId !== null) {
    const byRun = teamState.turnAuthorByTurnId.get(runId);
    if (byRun && byRun.threadId === threadId) return byRun;
  }
  if (userMessageId !== undefined && userMessageId !== null) {
    const byMessage = teamState.turnAuthorByTurnId.get(`msg:${userMessageId}`);
    if (byMessage && byMessage.threadId === threadId) return byMessage;
  }
  // Never fall back to latestTurnByThreadId when no runId/userMessageId is provided:
  // a colleague's newly queued run updates latestTurnByThreadId and must not impersonate the active turn's author.
  if (
    (runId === undefined || runId === null) &&
    (userMessageId === undefined || userMessageId === null)
  ) {
    return undefined;
  }
  const latest = teamState.latestTurnByThreadId.get(threadId);
  if (
    latest &&
    ((runId !== undefined && runId !== null && latest.turnId === runId) ||
      (userMessageId !== undefined &&
        userMessageId !== null &&
        latest.turnId === `msg:${userMessageId}`))
  ) {
    return latest;
  }
  return undefined;
}

export function resolveTeamQueuedRunAuthorPseudo(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
  readonly runId: string;
  readonly userMessageId?: string | null | undefined;
}): string | null {
  const { teamState, threadId, runId, userMessageId } = input;
  if (!teamState || teamState.team === null) return null;
  const turn = resolveTurnAttribution({ teamState, threadId, runId, userMessageId });
  if (!turn) return null;
  if (turn.authorKind === "team_automation" || turn.authorMemberId === null) {
    return teamState.team.name;
  }
  return teamState.memberById.get(turn.authorMemberId)?.pseudo ?? turn.authorPseudo;
}

function resolveActiveTurnAuthorKindForClient(input: {
  readonly teamState: TeamEnvironmentState;
  readonly threadId: ThreadId;
  readonly activeRunId?: string | null | undefined;
  readonly activeUserMessageId?: string | null | undefined;
}): TeamTurnAuthorKind | null {
  const activeTurn = resolveTurnAttribution({
    teamState: input.teamState,
    threadId: input.threadId,
    runId: input.activeRunId,
    userMessageId: input.activeUserMessageId,
  });
  if (!activeTurn) return null;
  return (
    activeTurn.authorKind ?? (activeTurn.authorMemberId === null ? "team_automation" : "member")
  );
}

export function canCurrentMemberSteerActiveTurn(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
  readonly activeRunId?: string | null | undefined;
  readonly activeUserMessageId?: string | null | undefined;
}): boolean {
  const { teamState, threadId, activeRunId, activeUserMessageId } = input;
  if (!teamState || teamState.team === null) return true;
  const attribution = teamState.attributionByThreadId.get(threadId) ?? null;
  if (attribution === null) return true;
  const view = resolveTeamThreadView({ teamState, threadId });
  const activeTurnAuthorKind = resolveActiveTurnAuthorKindForClient({
    teamState,
    threadId,
    activeRunId,
    activeUserMessageId,
  });
  return canMemberSteerActiveTeamTurn({
    member: teamState.currentMember,
    attribution,
    view,
    activeTurnAuthorKind,
  });
}

export function canCurrentMemberPromoteQueuedRun(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
  readonly activeRunId?: string | null | undefined;
  readonly activeUserMessageId?: string | null | undefined;
}): boolean {
  const { teamState, threadId, activeRunId, activeUserMessageId } = input;
  if (!teamState || teamState.team === null) return true;
  const attribution = teamState.attributionByThreadId.get(threadId) ?? null;
  if (attribution === null) return true;
  const view = resolveTeamThreadView({ teamState, threadId });
  const activeTurnAuthorKind = resolveActiveTurnAuthorKindForClient({
    teamState,
    threadId,
    activeRunId,
    activeUserMessageId,
  });
  return canMemberPromoteTeamQueuedRun({
    member: teamState.currentMember,
    attribution,
    view,
    activeTurnAuthorKind,
  });
}

export interface TeamThreadInterruptPermission {
  readonly canInterrupt: boolean;
  readonly isExplicitAdminInterrupt: boolean;
}

export function canCurrentMemberInterruptThread(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
  readonly activeRunId?: string | null | undefined;
  readonly activeUserMessageId?: string | null | undefined;
}): TeamThreadInterruptPermission {
  const { teamState, threadId, activeRunId, activeUserMessageId } = input;
  if (!teamState || teamState.team === null) {
    return { canInterrupt: true, isExplicitAdminInterrupt: false };
  }
  const member = teamState.currentMember;
  if (member === null || member.status !== "active") {
    return { canInterrupt: false, isExplicitAdminInterrupt: false };
  }
  const attribution = teamState.attributionByThreadId.get(threadId) ?? null;
  if (attribution === null) {
    return { canInterrupt: true, isExplicitAdminInterrupt: false };
  }
  const view = resolveTeamThreadView({ teamState, threadId });
  const activeTurn = resolveTurnAttribution({
    teamState,
    threadId,
    runId: activeRunId,
    userMessageId: activeUserMessageId,
  });
  const activeTurnAuthorMemberId: TeamMemberId | null =
    activeTurn !== undefined
      ? activeTurn.authorMemberId
      : attribution.locked
        ? null
        : attribution.creatorMemberId;
  const canInterrupt = canMemberInterruptTeamTurn({
    member,
    attribution,
    view,
    activeTurnAuthorMemberId,
  });
  const isExplicitAdminInterrupt =
    canInterrupt &&
    (isTeamAdminRole(member.role) || member.role === "modo") &&
    attribution.creatorMemberId !== member.id &&
    activeTurnAuthorMemberId !== member.id;
  return { canInterrupt, isExplicitAdminInterrupt };
}

function canCurrentMemberRespondToRuntimeRequest(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
  readonly activeRunId?: string | null | undefined;
  readonly activeUserMessageId?: string | null | undefined;
}): boolean {
  const { teamState, threadId, activeRunId, activeUserMessageId } = input;
  if (!teamState || teamState.team === null) return true;
  const member = teamState.currentMember;
  if (member === null || member.status !== "active") return false;
  const attribution = teamState.attributionByThreadId.get(threadId) ?? null;
  if (attribution === null) return true;
  const view = resolveTeamThreadView({ teamState, threadId });
  const activeTurn = resolveTurnAttribution({
    teamState,
    threadId,
    runId: activeRunId,
    userMessageId: activeUserMessageId,
  });
  const activeTurnAuthorMemberId: TeamMemberId | null =
    activeTurn !== undefined
      ? activeTurn.authorMemberId
      : attribution.locked
        ? null
        : attribution.creatorMemberId;
  return canMemberRespondToTeamRuntimeRequest({
    member,
    attribution,
    view,
    activeTurnAuthorMemberId,
  });
}

export function canCurrentMemberManageQueuedRun(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
  readonly runId: string;
  readonly userMessageId?: string | null | undefined;
}): boolean {
  const { teamState, threadId, runId, userMessageId } = input;
  if (!teamState || teamState.team === null) return true;
  const attribution = teamState.attributionByThreadId.get(threadId) ?? null;
  if (attribution === null) return true;
  const view = resolveTeamThreadView({ teamState, threadId });
  const queuedTurn = resolveTurnAttribution({ teamState, threadId, runId, userMessageId });
  return canMemberManageTeamQueuedRun({
    member: teamState.currentMember,
    attribution,
    view,
    queuedRunAuthorMemberId: queuedTurn?.authorMemberId ?? null,
  });
}

export interface TeamThreadTurnControls {
  readonly isTeamThread: boolean;
  readonly canSteerActiveTurn: boolean;
  readonly canPromoteQueuedRun: boolean;
  readonly canInterrupt: boolean;
  readonly canRespondToRuntimeRequest: boolean;
  readonly isExplicitAdminInterrupt: boolean;
}

export const TEAM_THREAD_TURN_CONTROLS_DEFAULT: TeamThreadTurnControls = {
  isTeamThread: false,
  canSteerActiveTurn: true,
  canPromoteQueuedRun: true,
  canInterrupt: true,
  canRespondToRuntimeRequest: true,
  isExplicitAdminInterrupt: false,
};

export function resolveTeamThreadTurnControls(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
  readonly activeRunId?: string | null | undefined;
  readonly activeUserMessageId?: string | null | undefined;
}): TeamThreadTurnControls {
  const { teamState, threadId, activeRunId, activeUserMessageId } = input;
  if (!teamState || teamState.team === null) {
    return TEAM_THREAD_TURN_CONTROLS_DEFAULT;
  }
  const interrupt = canCurrentMemberInterruptThread({
    teamState,
    threadId,
    activeRunId,
    activeUserMessageId,
  });
  return {
    isTeamThread: true,
    canSteerActiveTurn: canCurrentMemberSteerActiveTurn({
      teamState,
      threadId,
      activeRunId,
      activeUserMessageId,
    }),
    canPromoteQueuedRun: canCurrentMemberPromoteQueuedRun({
      teamState,
      threadId,
      activeRunId,
      activeUserMessageId,
    }),
    canInterrupt: interrupt.canInterrupt,
    canRespondToRuntimeRequest: canCurrentMemberRespondToRuntimeRequest({
      teamState,
      threadId,
      activeRunId,
      activeUserMessageId,
    }),
    isExplicitAdminInterrupt: interrupt.isExplicitAdminInterrupt,
  };
}

export interface ResolvedProjectTeamAssignment {
  readonly teamEnvironmentId: EnvironmentId;
  readonly team: TeamWorkspace;
  readonly assignment: TeamProjectAssignment;
  readonly teamState: TeamEnvironmentState;
}

export function extractProjectRepoIdentityKey(
  repositoryIdentity: RepositoryIdentity | null | undefined,
): string | null {
  if (!repositoryIdentity) return null;
  return repositoryIdentity.origin?.canonicalKey ?? repositoryIdentity.canonicalKey;
}

/**
 * Resolves whether a project (on a Team Server or a correlated local checkout) belongs to a team.
 * Correlates clones across environments using T3 Code's canonical `RepositoryIdentity`.
 */
export function resolveProjectTeamAssignment(input: {
  readonly project:
    | {
        readonly id: ProjectId;
        readonly environmentId: EnvironmentId;
        readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
      }
    | null
    | undefined;
  readonly teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>;
}): ResolvedProjectTeamAssignment | null {
  const { project, teamStates } = input;
  if (!project) return null;
  const owning = resolveOwningTeamEnvironment({ environmentId: project.environmentId, teamStates });
  const direct = owning?.teamState.projectAssignmentByProjectId.get(project.id);
  if (owning && direct && owning.teamState.team) {
    return {
      teamEnvironmentId: owning.teamEnvironmentId,
      team: owning.teamState.team,
      assignment: direct,
      teamState: owning.teamState,
    };
  }
  const repoKey = extractProjectRepoIdentityKey(project.repositoryIdentity);
  if (repoKey !== null) {
    for (const [envId, state] of teamStates) {
      if (state.team === null) continue;
      const correlated = state.projectAssignmentByRepoKey.get(repoKey);
      if (correlated) {
        return {
          teamEnvironmentId: envId,
          team: state.team,
          assignment: correlated,
          teamState: state,
        };
      }
    }
  }
  return null;
}

export interface ResolvedOwningTeamEnvironment {
  readonly teamEnvironmentId: EnvironmentId;
  readonly teamState: TeamEnvironmentState;
}

/**
 * Resolves the owning Team Server for either a Team Server itself or an attached runner
 * (`t3runner`) registered in a connected team's `environmentById`.
 */
export function resolveOwningTeamEnvironment(input: {
  readonly environmentId: EnvironmentId;
  readonly teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>;
}): ResolvedOwningTeamEnvironment | null {
  const direct = input.teamStates.get(input.environmentId);
  if (direct != null && direct.team !== null) {
    return { teamEnvironmentId: input.environmentId, teamState: direct };
  }
  for (const [teamEnvironmentId, state] of input.teamStates) {
    if (state.team === null) continue;
    if (state.environmentById.has(input.environmentId)) {
      return { teamEnvironmentId, teamState: state };
    }
  }
  return null;
}

/** Returns true when an environment is running in `--team-hub-only` control-plane mode. */
export function isTeamHubOnlyServerConfig(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): boolean {
  return serverConfig?.environment?.capabilities?.teamHubOnly === true;
}

export interface CorrelatedLocalSyncedTeamThread {
  readonly teamEnvironmentId: EnvironmentId;
  readonly teamState: TeamEnvironmentState;
  readonly attribution: TeamThreadAttribution;
}

/**
 * Finds the Team Server attribution when the displayed thread lives on an execution environment.
 */
export function resolveCorrelatedLocalSyncedTeamThread(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>;
}): CorrelatedLocalSyncedTeamThread | null {
  for (const [teamEnvironmentId, teamState] of input.teamStates) {
    if (teamState.team === null) continue;
    const attribution = teamState.attributionByThreadId.get(input.threadId);
    if (attribution?.executionEnvironmentId === input.environmentId) {
      return { teamEnvironmentId, teamState, attribution };
    }
  }
  return null;
}

/**
 * Returns true when `(environmentId, threadId)` is a Team Server mirrored copy of the signed-in
 * member's own local-synced thread and the live local `(executionEnvironmentId, threadId)` thread
 * is already present in the client (preventing duplicate sidebar rows).
 */
export function isDuplicateMirroredLocalTeamThread(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>;
  readonly liveLocalThreadKeys: ReadonlySet<string>;
}): boolean {
  const teamState = input.teamStates.get(input.environmentId);
  if (!teamState || teamState.team === null || teamState.currentMember === null) {
    return false;
  }
  const attribution = teamState.attributionByThreadId.get(input.threadId);
  if (
    !attribution ||
    attribution.isLocalSynced !== true ||
    attribution.creatorMemberId !== teamState.currentMember.id ||
    attribution.executionEnvironmentId == null
  ) {
    return false;
  }
  return input.liveLocalThreadKeys.has(`${attribution.executionEnvironmentId}\0${input.threadId}`);
}

/**
 * Resolves a target-compatible `team:<teamId>:*` model selection for team thread forks,
 * excluding `remote-only` and disabled providers on local targets (returns `null` if none fit).
 */
export function resolveTeamForkModelSelection(input: {
  readonly sourceModelSelection: ModelSelection | null | undefined;
  readonly targetProviders: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "driver" | "enabled" | "status" | "models">
  >;
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly isLocalTarget: boolean;
}): ModelSelection | null {
  const { sourceModelSelection, targetProviders, teamState, isLocalTarget } = input;
  if (!teamState || teamState.team === null) {
    return sourceModelSelection ?? null;
  }
  const teamId = teamState.team.id;
  const providerMetaBySourceId = new Map(
    teamState.providers.map((provider) => [provider.providerInstanceId, provider] as const),
  );
  const usableProviders = targetProviders.filter((entry) => {
    if (!entry.enabled || entry.status === "disabled") return false;
    const parsed = parseTeamProviderInstanceId(entry.instanceId);
    if (parsed?.teamId !== teamId) return false;
    const meta = providerMetaBySourceId.get(parsed.sourceInstanceId);
    if (isLocalTarget) return meta?.enabled === true && meta.deliveryStrategy !== "remote-only";
    return meta?.enabled !== false;
  });
  if (usableProviders.length === 0) {
    return null;
  }
  if (sourceModelSelection != null) {
    const exactMatch = usableProviders.find(
      (entry) => entry.instanceId === sourceModelSelection.instanceId,
    );
    if (
      exactMatch &&
      (exactMatch.models.length === 0 ||
        exactMatch.models.some((model) => model.slug === sourceModelSelection.model))
    ) {
      return sourceModelSelection;
    }
  }
  const sourceParsed =
    sourceModelSelection != null
      ? parseTeamProviderInstanceId(sourceModelSelection.instanceId)
      : null;
  const sourceDriver =
    sourceParsed !== null
      ? providerMetaBySourceId.get(sourceParsed.sourceInstanceId)?.driver
      : undefined;
  const preferred =
    (sourceDriver !== undefined
      ? (usableProviders.find(
          (entry) => entry.driver === sourceDriver && entry.status === "ready",
        ) ?? usableProviders.find((entry) => entry.driver === sourceDriver))
      : undefined) ??
    usableProviders.find((entry) => entry.status === "ready") ??
    usableProviders[0]!;
  const defaultModel = preferred.models[0]?.slug ?? DEFAULT_MODEL_BY_PROVIDER[preferred.driver];
  return defaultModel === undefined
    ? null
    : createModelSelection(preferred.instanceId, defaultModel);
}

export function listAccessibleTeamEnvironments(
  teamState: TeamEnvironmentState | null | undefined,
): ReadonlyArray<TeamEnvironment> {
  if (!teamState || teamState.team === null || teamState.currentMember === null) {
    return [];
  }
  return teamState.environments.filter((env) =>
    canMemberAccessTeamEnvironment(teamState.currentMember, env),
  );
}

export const TEAM_THREAD_ENV_ACCESS_ALLOWED: TeamThreadEnvironmentAccess = {
  canExecute: true,
  reason: "ok",
};

export function resolveTeamThreadEnvironmentAccessForClient(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
  readonly viewingOnLocalExecutionEnvironment?: boolean;
}): TeamThreadEnvironmentAccess {
  const { teamState, threadId, viewingOnLocalExecutionEnvironment = false } = input;
  if (!teamState || teamState.team === null) {
    return TEAM_THREAD_ENV_ACCESS_ALLOWED;
  }
  const attribution = teamState.attributionByThreadId.get(threadId) ?? null;
  if (attribution === null) {
    return TEAM_THREAD_ENV_ACCESS_ALLOWED;
  }
  return resolveTeamThreadEnvironmentAccess({
    member: teamState.currentMember,
    attribution,
    environments: teamState.environments,
    viewingOnLocalExecutionEnvironment,
  });
}

export function canCurrentMemberLeaveThreadNote(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
}): boolean {
  const { teamState, threadId } = input;
  if (!teamState || teamState.team === null || teamState.currentMember === null) {
    return false;
  }
  const attribution = teamState.attributionByThreadId.get(threadId) ?? null;
  if (!attribution) return false;
  const view = resolveTeamThreadView({ teamState, threadId });
  return canMemberLeaveTeamThreadNote({
    member: teamState.currentMember,
    attribution,
    view,
  });
}

export function canCurrentMemberResolveThreadNotes(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
  readonly viewingOnLocalExecutionEnvironment?: boolean;
}): boolean {
  const { teamState, threadId, viewingOnLocalExecutionEnvironment = false } = input;
  if (!teamState || teamState.team === null || teamState.currentMember === null) {
    return false;
  }
  const attribution = teamState.attributionByThreadId.get(threadId) ?? null;
  if (!attribution) return false;
  if (attribution.isLocalSynced === true) {
    return attribution.creatorMemberId === teamState.currentMember.id;
  }
  const postPermission = resolveTeamThreadPostPermission({ teamState, threadId });
  if (!postPermission.canPost) return false;
  const envAccess = resolveTeamThreadEnvironmentAccessForClient({
    teamState,
    threadId,
    viewingOnLocalExecutionEnvironment,
  });
  return envAccess.canExecute;
}

const EMPTY_THREAD_NOTES: ReadonlyArray<TeamThreadNote> = [];

export function resolveTeamThreadNotes(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
}): ReadonlyArray<TeamThreadNote> {
  const { teamState, threadId } = input;
  if (!teamState || teamState.team === null) return EMPTY_THREAD_NOTES;
  return teamState.threadNotesByThreadId.get(threadId) ?? EMPTY_THREAD_NOTES;
}

export function resolveTeamThreadPendingNotes(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
}): ReadonlyArray<TeamThreadNote> {
  return resolveTeamThreadNotes(input).filter((note) => note.status === "pending");
}

export function resolveTeamThreadAcceptedNotes(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly threadId: ThreadId;
}): ReadonlyArray<TeamThreadNote> {
  return resolveTeamThreadNotes(input).filter((note) => note.status === "accepted");
}

/**
 * Enforces the strict Milestone 6 provider isolation invariant in the client model picker:
 * - On any project assigned to team `T`, ONLY `team:<T>:*` virtual instances are exposed (never personal credentials).
 * - On personal projects, all `team:*` virtual instances are excluded.
 */
export function filterProviderEntriesForTeamProject<
  T extends { readonly instanceId: ProviderInstanceId },
>(input: {
  readonly entries: ReadonlyArray<T>;
  readonly teamAssignment: ResolvedProjectTeamAssignment | null | undefined;
}): ReadonlyArray<T> {
  if (input.teamAssignment != null) {
    const teamId = input.teamAssignment.team.id;
    return input.entries.filter((entry) =>
      isTeamProviderInstanceIdForTeam(entry.instanceId, teamId),
    );
  }
  return input.entries.filter((entry) => !isTeamProviderInstanceId(entry.instanceId));
}

export function listRemoteOnlyTeamProviders(
  teamAssignment: ResolvedProjectTeamAssignment | null | undefined,
): ReadonlyArray<TeamProvider> {
  if (teamAssignment == null) return [];
  return teamAssignment.teamState.providers.filter(
    (provider) => provider.enabled && provider.deliveryStrategy === "remote-only",
  );
}

export function resolveTeamScheduledTaskMeta(
  teamState: TeamEnvironmentState | null | undefined,
  taskId: ScheduledTaskId,
): TeamScheduledTaskMeta | null {
  if (!teamState || teamState.team === null) return null;
  return teamState.scheduledTaskMetaByTaskId.get(taskId) ?? null;
}

export function canCurrentMemberConfigurePrivilegedTeamScheduledTask(
  teamState: TeamEnvironmentState | null | undefined,
): boolean {
  if (!teamState || teamState.team === null || teamState.currentMember === null) return false;
  return (
    teamState.currentMember.status === "active" &&
    canManagePrivilegedTeamScheduledTasks(teamState.currentMember.role)
  );
}

export function canCurrentMemberCreateTeamScheduledTask(
  teamState: TeamEnvironmentState | null | undefined,
  environmentId?: EnvironmentId | null,
): boolean {
  if (!teamState || teamState.team === null) return true;
  const member = teamState.currentMember;
  if (member === null || member.status !== "active" || !canManageTeamScheduledTasks(member.role)) {
    return false;
  }
  const targetEnv =
    environmentId != null
      ? (teamState.environmentById.get(environmentId) ??
        teamState.environments.find((env) => env.isDefault) ??
        null)
      : (teamState.environments.find((env) => env.isDefault) ?? teamState.environments[0] ?? null);
  if (targetEnv !== null && !canMemberAccessTeamEnvironment(member, targetEnv)) {
    return false;
  }
  return listAccessibleTeamViews(teamState).length > 0;
}

export function canCurrentMemberMutateTeamScheduledTask(input: {
  readonly teamState: TeamEnvironmentState | null | undefined;
  readonly taskId: ScheduledTaskId;
  readonly environmentId?: EnvironmentId | null;
  readonly boundThreadId?: ThreadId | null;
}): boolean {
  const { teamState, taskId, environmentId, boundThreadId } = input;
  if (!teamState || teamState.team === null) return true;
  const member = teamState.currentMember;
  if (member === null || member.status !== "active") return false;
  const meta = teamState.scheduledTaskMetaByTaskId.get(taskId) ?? null;
  if (meta === null && !isTeamAdminRole(member.role)) {
    // Match server fail-closed rule: unattributed/unhydrated team tasks are owner/admin-only.
    return false;
  }
  const hostEnvironment =
    environmentId != null
      ? (teamState.environmentById.get(environmentId) ??
        teamState.environments.find((env) => env.isDefault) ??
        null)
      : (teamState.environments.find((env) => env.isDefault) ?? null);
  if (hostEnvironment !== null && !canMemberAccessTeamEnvironment(member, hostEnvironment)) {
    return false;
  }
  if (meta !== null) {
    const metaEnvironment =
      teamState.environmentById.get(meta.environmentId) ?? hostEnvironment ?? null;
    const view = teamState.viewById.get(meta.viewId) ?? resolveTeamDefaultView(teamState);
    if (
      !canMemberMutateTeamScheduledTask({
        member,
        environment: metaEnvironment,
        view,
        existingMeta: { locked: meta.locked, mcpAccessLevel: meta.mcpAccessLevel },
      })
    ) {
      return false;
    }
  }
  if (boundThreadId != null) {
    const attribution = teamState.attributionByThreadId.get(boundThreadId) ?? null;
    if (attribution === null) {
      return isTeamAdminRole(member.role);
    }
    const threadView =
      teamState.viewById.get(attribution.viewId) ?? resolveTeamDefaultView(teamState);
    if (resolveTeamThreadPostBlockReason({ member, attribution, view: threadView }) !== "ok") {
      return false;
    }
    const envAccess = resolveTeamThreadEnvironmentAccess({
      member,
      attribution,
      environments: teamState.environments,
    });
    if (!envAccess.canExecute) {
      return false;
    }
  }
  return true;
}

export interface ConnectedTeamSummary {
  readonly environmentId: EnvironmentId;
  readonly team: TeamWorkspace;
}

/** Deduplicates connected team environments by `team.id`, preserving connection order. */
export function listConnectedTeams(
  teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>,
): ReadonlyArray<ConnectedTeamSummary> {
  const seenTeamIds = new Set<TeamId>();
  const connected: Array<ConnectedTeamSummary> = [];
  for (const [environmentId, state] of teamStates) {
    if (state.team === null || seenTeamIds.has(state.team.id)) continue;
    seenTeamIds.add(state.team.id);
    connected.push({ environmentId, team: state.team });
  }
  return connected;
}

/**
 * Resolves the effective notification sound preset for a thread:
 * - Personal threads (`teamId === null`) always keep upstream's `"classic"` preset.
 * - Team threads use the per-team configured preset, defaulting to `"chime"` so
 *   team alerts are immediately distinct from personal alerts.
 */
export function resolveTeamNotificationSoundPreset(input: {
  readonly teamId: TeamId | string | null | undefined;
  readonly teamNotificationSounds?:
    | Readonly<Record<string, TeamNotificationSoundPreset>>
    | null
    | undefined;
}): TeamNotificationSoundPreset {
  if (input.teamId == null || input.teamId === "") {
    return "classic";
  }
  const sounds = input.teamNotificationSounds;
  if (sounds && Object.hasOwn(sounds, input.teamId)) {
    const configured = sounds[input.teamId];
    if (configured !== undefined) {
      return configured;
    }
  }
  return DEFAULT_TEAM_NOTIFICATION_SOUND;
}

/**
 * Resolves the owning `TeamId` for a thread across both:
 * 1. Remote Team Server threads (`teamStates.get(environmentId)?.team?.id`), and
 * 2. Local-environment threads belonging to a team-assigned project (via repo identity
 *    correlation or local-synced thread attribution).
 */
export function resolveThreadTeamId(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly project?:
    | {
        readonly id: ProjectId;
        readonly environmentId: EnvironmentId;
        readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
      }
    | null
    | undefined;
  readonly teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>;
}): TeamId | null {
  const direct = input.teamStates.get(input.environmentId);
  if (direct?.team != null) {
    return direct.attributionByThreadId.get(input.threadId)?.teamId ?? direct.team.id;
  }
  if (input.project != null) {
    const assignment = resolveProjectTeamAssignment({
      project: input.project,
      teamStates: input.teamStates,
    });
    if (assignment !== null) {
      return assignment.assignment.teamId;
    }
  }
  for (const state of input.teamStates.values()) {
    if (state.team === null) continue;
    const attribution = state.attributionByThreadId.get(input.threadId);
    if (
      attribution?.isLocalSynced === true &&
      (attribution.executionEnvironmentId == null ||
        attribution.executionEnvironmentId === input.environmentId)
    ) {
      return attribution.teamId;
    }
  }
  return null;
}
