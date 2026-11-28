import { useAtomValue } from "@effect/atom-react";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import {
  canCurrentMemberChangeThreadView,
  canCurrentMemberLeaveThreadNote,
  canCurrentMemberResolveThreadNotes,
  canCurrentMemberToggleThreadLock,
  createTeamEnvironmentAtoms,
  EMPTY_TEAM_ENVIRONMENT_STATE,
  isFollowingTeamThread,
  isTeamColleagueThread,
  isTeamThreadLocked,
  listAccessibleTeamEnvironments,
  listAccessibleTeamViews,
  previewTeamInviteEffect,
  redeemTeamInviteAndConnectEffect,
  resolveCorrelatedLocalSyncedTeamThread,
  resolveProjectTeamAssignment,
  resolveTeamThreadAcceptedNotes,
  resolveTeamThreadCreatorPseudo,
  resolveTeamThreadEnvironmentAccessForClient,
  resolveTeamThreadNotes,
  resolveTeamThreadPendingNotes,
  resolveTeamThreadPostPermission,
  resolveTeamThreadTurnControls,
  resolveTeamThreadView,
  TEAM_THREAD_ENV_ACCESS_ALLOWED,
  TEAM_THREAD_POST_ALLOWED,
  TEAM_THREAD_TURN_CONTROLS_DEFAULT,
  type ResolvedProjectTeamAssignment,
  type TeamEnvironmentState,
  type TeamInviteJoinInput,
  type TeamInvitePreviewInput,
  type TeamThreadPostPermission,
  type TeamThreadTurnControls,
} from "@t3tools/client-runtime/team";
import type {
  EnvironmentId,
  ProjectId,
  RepositoryIdentity,
  TeamEnvironment,
  TeamThreadEnvironmentAccess,
  TeamThreadNote,
  TeamView,
  TeamViewId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { useEnvironments } from "./environments";
import { environmentSummaries } from "./presentation";

const SHOW_COLLEAGUES_THREADS_STORAGE_KEY = "t3code:team:show-colleagues-threads";
const SHOW_FOLLOWED_THREADS_ONLY_STORAGE_KEY = "t3code:team:show-followed-threads-only";

function readStoredBoolean(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function writeStoredBoolean(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // Ignore storage quota or private-mode errors.
  }
}

const initialFollowedOnly = readStoredBoolean(SHOW_FOLLOWED_THREADS_ONLY_STORAGE_KEY);
const initialShowColleagues = initialFollowedOnly
  ? false
  : readStoredBoolean(SHOW_COLLEAGUES_THREADS_STORAGE_KEY);

const showColleaguesThreadsAtom = Atom.make(initialShowColleagues).pipe(
  Atom.keepAlive,
  Atom.withLabel("team:show-colleagues-threads"),
);

const showFollowedThreadsOnlyAtom = Atom.make(initialFollowedOnly).pipe(
  Atom.keepAlive,
  Atom.withLabel("team:show-followed-threads-only"),
);

export function useShowColleaguesThreads(): boolean {
  return useAtomValue(showColleaguesThreadsAtom);
}

export function setShowColleaguesThreads(next: boolean): void {
  appAtomRegistry.set(showColleaguesThreadsAtom, next);
  writeStoredBoolean(SHOW_COLLEAGUES_THREADS_STORAGE_KEY, next);
  // Keep sidebar filter modes mutually exclusive so toggling colleagues never gets stuck in followed-only.
  appAtomRegistry.set(showFollowedThreadsOnlyAtom, false);
  writeStoredBoolean(SHOW_FOLLOWED_THREADS_ONLY_STORAGE_KEY, false);
}

export function toggleShowColleaguesThreads(): boolean {
  const next = !appAtomRegistry.get(showColleaguesThreadsAtom);
  setShowColleaguesThreads(next);
  return next;
}

export type TeamSidebarFilterMode = "mine" | "followed" | "all";

export function resolveTeamSidebarFilterMode(
  showColleagues: boolean,
  showFollowedOnly: boolean,
): TeamSidebarFilterMode {
  if (showFollowedOnly) return "followed";
  if (showColleagues) return "all";
  return "mine";
}

export function useTeamSidebarFilterMode(): TeamSidebarFilterMode {
  const showColleagues = useShowColleaguesThreads();
  const showFollowedOnly = useShowFollowedThreadsOnly();
  return resolveTeamSidebarFilterMode(showColleagues, showFollowedOnly);
}

export function setTeamSidebarFilterMode(mode: TeamSidebarFilterMode): void {
  if (mode === "followed") {
    setShowFollowedThreadsOnly(true);
    return;
  }
  setShowColleaguesThreads(mode === "all");
}

export function cycleTeamSidebarFilterMode(): TeamSidebarFilterMode {
  const current = resolveTeamSidebarFilterMode(
    appAtomRegistry.get(showColleaguesThreadsAtom),
    appAtomRegistry.get(showFollowedThreadsOnlyAtom),
  );
  const next: TeamSidebarFilterMode =
    current === "mine" ? "followed" : current === "followed" ? "all" : "mine";
  setTeamSidebarFilterMode(next);
  return next;
}

export function useShowFollowedThreadsOnly(): boolean {
  return useAtomValue(showFollowedThreadsOnlyAtom);
}

export function setShowFollowedThreadsOnly(next: boolean): void {
  appAtomRegistry.set(showFollowedThreadsOnlyAtom, next);
  writeStoredBoolean(SHOW_FOLLOWED_THREADS_ONLY_STORAGE_KEY, next);
  if (next) {
    appAtomRegistry.set(showColleaguesThreadsAtom, false);
    writeStoredBoolean(SHOW_COLLEAGUES_THREADS_STORAGE_KEY, false);
  }
}

export function toggleShowFollowedThreadsOnly(): boolean {
  const next = !appAtomRegistry.get(showFollowedThreadsOnlyAtom);
  setShowFollowedThreadsOnly(next);
  return next;
}

export const teamEnvironment = createTeamEnvironmentAtoms(connectionAtomRuntime);

/** Returns null while the environment's team state stream has not resolved yet. */
export function readTeamEnvironmentStateFromRegistry(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): TeamEnvironmentState | null {
  const result = registry.get(teamEnvironment.state(environmentId));
  return result._tag === "Success" ? result.value : null;
}

const emptyTeamResultAtom = Atom.make<AsyncResult.AsyncResult<TeamEnvironmentState, unknown>>(
  AsyncResult.success(EMPTY_TEAM_ENVIRONMENT_STATE),
).pipe(Atom.withLabel("team:empty-state"));

const teamStatesByEnvironmentAtom = environmentAtomList("team:states", (environmentId) =>
  teamEnvironment.state(environmentId),
);

const teamStatesMapAtom = Atom.family((idsKey: string) =>
  Atom.make((get): ReadonlyMap<EnvironmentId, TeamEnvironmentState> => {
    const map = new Map<EnvironmentId, TeamEnvironmentState>();
    if (idsKey.length === 0) return map;
    const ids = idsKey.split("\n") as Array<EnvironmentId>;
    const results = get(teamStatesByEnvironmentAtom(idsKey));
    for (let index = 0; index < ids.length; index += 1) {
      const environmentId = ids[index]!;
      const result = results[index];
      if (result?._tag === "Success") {
        map.set(environmentId, result.value);
      }
    }
    return map;
  }).pipe(Atom.withLabel(`team:states-map:${idsKey}`)),
);

const connectedTeamStatesAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, TeamEnvironmentState> => {
    const connectedIds = [...get(environmentSummaries.connectedEnvironmentIdsAtom)];
    return get(teamStatesMapAtom(environmentIdsKey(connectedIds)));
  },
).pipe(Atom.withLabel("team:connected-states"));

const teamThreadLocationAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => {
    const separatorIndex = threadKey.indexOf("\0");
    if (separatorIndex === -1) return null;
    const environmentId = threadKey.slice(0, separatorIndex) as EnvironmentId;
    const threadId = threadKey.slice(separatorIndex + 1) as ThreadId;
    const result = get(teamEnvironment.state(environmentId));
    if (result._tag === "Success" && result.value.team !== null) {
      return { teamState: result.value, teamEnvironmentId: environmentId, threadId };
    }
    const correlated = resolveCorrelatedLocalSyncedTeamThread({
      environmentId,
      threadId,
      teamStates: get(connectedTeamStatesAtom),
    });
    return correlated ? { ...correlated, threadId } : null;
  }).pipe(Atom.withLabel(`team:thread-location:${threadKey}`)),
);

const teamThreadCreatorPseudoAtom = Atom.family((threadKey: string) =>
  Atom.make((get): string | null => {
    const location = get(teamThreadLocationAtom(threadKey));
    return location === null ? null : resolveTeamThreadCreatorPseudo(location);
  }).pipe(Atom.withLabel(`team:thread-creator-pseudo:${threadKey}`)),
);

// Stable singleton outputs avoid re-rendering every sidebar row on unrelated team stream events.
const FOLLOW_STATE_NONE = { canFollow: false, isFollowing: false } as const;
const FOLLOW_STATE_CAN_FOLLOW = { canFollow: true, isFollowing: false } as const;
const FOLLOW_STATE_FOLLOWING = { canFollow: true, isFollowing: true } as const;

const teamThreadFollowStateAtom = Atom.family((threadKey: string) =>
  Atom.make((get): { readonly canFollow: boolean; readonly isFollowing: boolean } => {
    const separatorIndex = threadKey.indexOf("\0");
    if (separatorIndex === -1) return FOLLOW_STATE_NONE;
    const environmentId = threadKey.slice(0, separatorIndex) as EnvironmentId;
    const threadId = threadKey.slice(separatorIndex + 1) as ThreadId;
    const result = get(teamEnvironment.state(environmentId));
    if (result._tag !== "Success" || result.value.team === null) {
      return FOLLOW_STATE_NONE;
    }
    if (!isTeamColleagueThread({ teamState: result.value, threadId })) {
      return FOLLOW_STATE_NONE;
    }
    return isFollowingTeamThread({ teamState: result.value, threadId })
      ? FOLLOW_STATE_FOLLOWING
      : FOLLOW_STATE_CAN_FOLLOW;
  }).pipe(Atom.withLabel(`team:thread-follow-state:${threadKey}`)),
);

export function useTeamEnvironmentState(environmentId: EnvironmentId | null): TeamEnvironmentState {
  const result = useAtomValue(
    environmentId === null ? emptyTeamResultAtom : teamEnvironment.state(environmentId),
  );
  return result._tag === "Success" ? result.value : EMPTY_TEAM_ENVIRONMENT_STATE;
}

export function useTeamStatesByEnvironment(): ReadonlyMap<EnvironmentId, TeamEnvironmentState> {
  const { environments } = useEnvironments();
  const connectedIds = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId);
  return useAtomValue(teamStatesMapAtom(environmentIdsKey(connectedIds)));
}

export function useTeamThreadCreatorPseudo(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string | null {
  return useAtomValue(teamThreadCreatorPseudoAtom(`${environmentId}\0${threadId}`));
}

export function useTeamThreadFollowState(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): { readonly canFollow: boolean; readonly isFollowing: boolean } {
  return useAtomValue(teamThreadFollowStateAtom(`${environmentId}\0${threadId}`));
}

export function readTeamThreadFollowActionState(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): { readonly isFollowing: boolean } | null {
  const state = appAtomRegistry.get(teamThreadFollowStateAtom(`${environmentId}\0${threadId}`));
  if (!state.canFollow) return null;
  const canMutate = appAtomRegistry.get(
    state.isFollowing
      ? teamEnvironment.unfollowThread.permissionAtom(environmentId)
      : teamEnvironment.followThread.permissionAtom(environmentId),
  );
  if (!canMutate) return null;
  return { isFollowing: state.isFollowing };
}

export interface TeamThreadAccessViewState {
  readonly isTeamThread: boolean;
  readonly teamEnvironmentId: EnvironmentId | null;
  readonly view: TeamView | null;
  readonly locked: boolean;
  readonly canChangeView: boolean;
  readonly canToggleLock: boolean;
  readonly accessibleViews: ReadonlyArray<TeamView>;
}

const EMPTY_THREAD_ACCESS_STATE: TeamThreadAccessViewState = {
  isTeamThread: false,
  teamEnvironmentId: null,
  view: null,
  locked: false,
  canChangeView: false,
  canToggleLock: false,
  accessibleViews: [],
};

const teamThreadAccessStateAtom = Atom.family((threadKey: string) =>
  Atom.make((get): TeamThreadAccessViewState => {
    const location = get(teamThreadLocationAtom(threadKey));
    if (location === null) return EMPTY_THREAD_ACCESS_STATE;
    const { teamState, teamEnvironmentId, threadId } = location;
    return {
      isTeamThread: true,
      teamEnvironmentId,
      view: resolveTeamThreadView({ teamState, threadId }),
      locked: isTeamThreadLocked({ teamState, threadId }),
      canChangeView: canCurrentMemberChangeThreadView(teamState),
      canToggleLock: canCurrentMemberToggleThreadLock(teamState),
      accessibleViews: listAccessibleTeamViews(teamState),
    };
  }).pipe(Atom.withLabel(`team:thread-access-state:${threadKey}`)),
);

const teamThreadPostPermissionAtom = Atom.family((threadKey: string) =>
  Atom.make((get): TeamThreadPostPermission => {
    const location = get(teamThreadLocationAtom(threadKey));
    return location === null ? TEAM_THREAD_POST_ALLOWED : resolveTeamThreadPostPermission(location);
  }).pipe(Atom.withLabel(`team:thread-post-permission:${threadKey}`)),
);

export function useTeamThreadAccessState(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): TeamThreadAccessViewState {
  return useAtomValue(teamThreadAccessStateAtom(`${environmentId}\0${threadId}`));
}

export function useTeamThreadPostPermission(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): TeamThreadPostPermission {
  return useAtomValue(teamThreadPostPermissionAtom(`${environmentId}\0${threadId}`));
}

export function readTeamThreadPostPermission(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): TeamThreadPostPermission {
  return appAtomRegistry.get(teamThreadPostPermissionAtom(`${environmentId}\0${threadId}`));
}

export function useTeamThreadTurnControls(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly activeRunId?: string | null;
  readonly activeUserMessageId?: string | null;
}): TeamThreadTurnControls {
  const teamState = useTeamEnvironmentState(input.environmentId);
  if (teamState.team === null) {
    return TEAM_THREAD_TURN_CONTROLS_DEFAULT;
  }
  return resolveTeamThreadTurnControls({
    teamState,
    threadId: input.threadId,
    activeRunId: input.activeRunId,
    activeUserMessageId: input.activeUserMessageId,
  });
}

export interface TeamThreadAccessMenuState {
  readonly teamEnvironmentId?: EnvironmentId | null;
  readonly teamView: {
    readonly currentViewId: TeamViewId | null;
    readonly views: ReadonlyArray<{ readonly id: TeamViewId; readonly name: string }>;
  } | null;
  readonly teamLock: {
    readonly isLocked: boolean;
  } | null;
}

export function readTeamThreadAccessActionState(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): TeamThreadAccessMenuState {
  const access = appAtomRegistry.get(teamThreadAccessStateAtom(`${environmentId}\0${threadId}`));
  if (!access.isTeamThread || access.teamEnvironmentId === null) {
    return { teamEnvironmentId: null, teamView: null, teamLock: null };
  }
  const targetEnvId = access.teamEnvironmentId;
  const canMutateView =
    access.canChangeView &&
    appAtomRegistry.get(teamEnvironment.setThreadView.permissionAtom(targetEnvId));
  const canMutateLock =
    access.canToggleLock &&
    appAtomRegistry.get(teamEnvironment.setThreadLocked.permissionAtom(targetEnvId));
  return {
    teamEnvironmentId: targetEnvId,
    teamView: canMutateView
      ? {
          currentViewId: access.view?.id ?? null,
          views: access.accessibleViews.map((view) => ({ id: view.id, name: view.name })),
        }
      : null,
    teamLock: canMutateLock ? { isLocked: access.locked } : null,
  };
}

export interface TeamDraftAccessOptions {
  readonly teamEnvironmentId: EnvironmentId | null;
  readonly viewId: TeamViewId | null;
  readonly locked: boolean;
}

const EMPTY_DRAFT_ACCESS_OPTIONS: TeamDraftAccessOptions = {
  teamEnvironmentId: null,
  viewId: null,
  locked: false,
};

const teamDraftAccessOptionsMapAtom = Atom.make<ReadonlyMap<string, TeamDraftAccessOptions>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("team:draft-access-options"));

const teamDraftAccessOptionsForKeyAtom = Atom.family((draftKey: string) =>
  Atom.make(
    (get): TeamDraftAccessOptions =>
      get(teamDraftAccessOptionsMapAtom).get(draftKey) ?? EMPTY_DRAFT_ACCESS_OPTIONS,
  ).pipe(Atom.withLabel(`team:draft-access-options:${draftKey}`)),
);

export function useTeamDraftAccessOptions(draftKey: string): TeamDraftAccessOptions {
  return useAtomValue(teamDraftAccessOptionsForKeyAtom(draftKey));
}

export function readTeamDraftAccessOptions(draftKey: string): TeamDraftAccessOptions {
  return (
    appAtomRegistry.get(teamDraftAccessOptionsMapAtom).get(draftKey) ?? EMPTY_DRAFT_ACCESS_OPTIONS
  );
}

export function setTeamDraftViewId(
  draftKey: string,
  viewId: TeamViewId | null,
  teamEnvironmentId: EnvironmentId,
): void {
  const current = appAtomRegistry.get(teamDraftAccessOptionsMapAtom);
  const existing = current.get(draftKey);
  const locked = existing?.teamEnvironmentId === teamEnvironmentId && existing.locked;
  const next = new Map(current);
  next.set(draftKey, { viewId, locked, teamEnvironmentId });
  appAtomRegistry.set(teamDraftAccessOptionsMapAtom, next);
}

export function setTeamDraftLocked(
  draftKey: string,
  locked: boolean,
  teamEnvironmentId: EnvironmentId,
): void {
  const current = appAtomRegistry.get(teamDraftAccessOptionsMapAtom);
  const existing = current.get(draftKey);
  const viewId = existing?.teamEnvironmentId === teamEnvironmentId ? existing.viewId : null;
  const next = new Map(current);
  next.set(draftKey, { viewId, locked, teamEnvironmentId });
  appAtomRegistry.set(teamDraftAccessOptionsMapAtom, next);
}

export function clearTeamDraftAccessOptions(draftKey: string): void {
  const current = appAtomRegistry.get(teamDraftAccessOptionsMapAtom);
  if (!current.has(draftKey)) return;
  const next = new Map(current);
  next.delete(draftKey);
  appAtomRegistry.set(teamDraftAccessOptionsMapAtom, next);
}

const localThreadAccess = new Map<string, TeamDraftAccessOptions>();
const localThreadAccessKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `t3code:team:local-thread-access:${environmentId}:${threadId}`;

export function readLocalThreadAccess(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): TeamDraftAccessOptions | null {
  const key = localThreadAccessKey(environmentId, threadId);
  const cached = localThreadAccess.get(key);
  if (cached !== undefined) return cached;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const saved = JSON.parse(raw) as TeamDraftAccessOptions | null;
    return saved &&
      typeof saved.teamEnvironmentId === "string" &&
      (saved.viewId === null || typeof saved.viewId === "string") &&
      typeof saved.locked === "boolean"
      ? saved
      : null;
  } catch {
    return null;
  }
}

export function prepareTeamThreadAccess(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  access: TeamDraftAccessOptions | null,
) {
  if (!access?.teamEnvironmentId) return {};
  if (access.teamEnvironmentId === environmentId) {
    return {
      ...(access.viewId !== null ? { teamViewId: access.viewId } : {}),
      ...(access.locked ? { teamLocked: true } : {}),
    };
  }
  const key = localThreadAccessKey(environmentId, threadId);
  localThreadAccess.set(key, access);
  try {
    window.localStorage.setItem(key, JSON.stringify(access));
  } catch {
    // The current tab retains the selection if browser storage is unavailable.
  }
  return {};
}

export function clearLocalThreadAccess(environmentId: EnvironmentId, threadId: ThreadId): void {
  const key = localThreadAccessKey(environmentId, threadId);
  localThreadAccess.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Browser storage may be unavailable.
  }
}

export const previewTeamInvite = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:team:preview-invite",
  execute: (input: TeamInvitePreviewInput) => previewTeamInviteEffect(input),
});

export const redeemTeamInvite = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:team:redeem-invite",
  execute: (input: TeamInviteJoinInput) => redeemTeamInviteAndConnectEffect(input),
});

export interface ResolvedThreadTeamContext {
  readonly teamEnvironmentId: EnvironmentId | null;
  readonly teamState: TeamEnvironmentState;
  readonly isViewingOnLocalExecutionEnvironment: boolean;
  readonly envAccess: TeamThreadEnvironmentAccess;
  readonly canLeaveNote: boolean;
  readonly canResolveNotes: boolean;
  readonly notes: ReadonlyArray<TeamThreadNote>;
  readonly pendingNotes: ReadonlyArray<TeamThreadNote>;
  readonly acceptedNotes: ReadonlyArray<TeamThreadNote>;
}

const EMPTY_NOTES: ReadonlyArray<TeamThreadNote> = [];

export function useProjectTeamAssignment(
  project:
    | {
        readonly id: ProjectId;
        readonly environmentId: EnvironmentId;
        readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
      }
    | null
    | undefined,
): ResolvedProjectTeamAssignment | null {
  const teamStates = useTeamStatesByEnvironment();
  return resolveProjectTeamAssignment({ project, teamStates });
}

export function useAccessibleTeamEnvironments(
  teamEnvironmentId: EnvironmentId | null,
): ReadonlyArray<TeamEnvironment> {
  const teamState = useTeamEnvironmentState(teamEnvironmentId);
  return listAccessibleTeamEnvironments(teamState);
}

/**
 * Resolves team context, environment execution access, and thread notes for either:
 * - a thread opened on a Team Server directly, or
 * - a local-environment thread belonging to a team-assigned project (correlated via repo identity).
 */
export function useTeamThreadContext(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly project:
    | {
        readonly id: ProjectId;
        readonly environmentId: EnvironmentId;
        readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
      }
    | null
    | undefined;
}): ResolvedThreadTeamContext {
  const teamStates = useTeamStatesByEnvironment();
  const directState = teamStates.get(input.environmentId) ?? null;
  if (directState !== null && directState.team !== null) {
    const envAccess = resolveTeamThreadEnvironmentAccessForClient({
      teamState: directState,
      threadId: input.threadId,
      viewingOnLocalExecutionEnvironment: false,
    });
    const notes = resolveTeamThreadNotes({ teamState: directState, threadId: input.threadId });
    return {
      teamEnvironmentId: input.environmentId,
      teamState: directState,
      isViewingOnLocalExecutionEnvironment: false,
      envAccess,
      canLeaveNote: canCurrentMemberLeaveThreadNote({
        teamState: directState,
        threadId: input.threadId,
      }),
      canResolveNotes: canCurrentMemberResolveThreadNotes({
        teamState: directState,
        threadId: input.threadId,
        viewingOnLocalExecutionEnvironment: false,
      }),
      notes,
      pendingNotes: resolveTeamThreadPendingNotes({
        teamState: directState,
        threadId: input.threadId,
      }),
      acceptedNotes: resolveTeamThreadAcceptedNotes({
        teamState: directState,
        threadId: input.threadId,
      }),
    };
  }
  const assignment = resolveProjectTeamAssignment({ project: input.project, teamStates });
  if (assignment !== null) {
    const envAccess = resolveTeamThreadEnvironmentAccessForClient({
      teamState: assignment.teamState,
      threadId: input.threadId,
      viewingOnLocalExecutionEnvironment: true,
    });
    const notes = resolveTeamThreadNotes({
      teamState: assignment.teamState,
      threadId: input.threadId,
    });
    return {
      teamEnvironmentId: assignment.teamEnvironmentId,
      teamState: assignment.teamState,
      isViewingOnLocalExecutionEnvironment: true,
      envAccess,
      canLeaveNote: false,
      canResolveNotes: canCurrentMemberResolveThreadNotes({
        teamState: assignment.teamState,
        threadId: input.threadId,
        viewingOnLocalExecutionEnvironment: true,
      }),
      notes,
      pendingNotes: resolveTeamThreadPendingNotes({
        teamState: assignment.teamState,
        threadId: input.threadId,
      }),
      acceptedNotes: resolveTeamThreadAcceptedNotes({
        teamState: assignment.teamState,
        threadId: input.threadId,
      }),
    };
  }
  return {
    teamEnvironmentId: null,
    teamState: EMPTY_TEAM_ENVIRONMENT_STATE,
    isViewingOnLocalExecutionEnvironment: false,
    envAccess: TEAM_THREAD_ENV_ACCESS_ALLOWED,
    canLeaveNote: false,
    canResolveNotes: false,
    notes: EMPTY_NOTES,
    pendingNotes: EMPTY_NOTES,
    acceptedNotes: EMPTY_NOTES,
  };
}

export function readTeamThreadNotesForSend(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly project:
    | {
        readonly id: ProjectId;
        readonly environmentId: EnvironmentId;
        readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
      }
    | null
    | undefined;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}): {
  readonly teamEnvironmentId: EnvironmentId | null;
  readonly isViewingOnLocalExecutionEnvironment: boolean;
  readonly envAccess: TeamThreadEnvironmentAccess;
  readonly pendingNotes: ReadonlyArray<TeamThreadNote>;
  readonly acceptedNotes: ReadonlyArray<TeamThreadNote>;
} {
  const direct = readTeamEnvironmentStateFromRegistry(appAtomRegistry, input.environmentId);
  if (direct !== null && direct.team !== null) {
    return {
      teamEnvironmentId: input.environmentId,
      isViewingOnLocalExecutionEnvironment: false,
      envAccess: resolveTeamThreadEnvironmentAccessForClient({
        teamState: direct,
        threadId: input.threadId,
        viewingOnLocalExecutionEnvironment: false,
      }),
      pendingNotes: resolveTeamThreadPendingNotes({ teamState: direct, threadId: input.threadId }),
      acceptedNotes: resolveTeamThreadAcceptedNotes({
        teamState: direct,
        threadId: input.threadId,
      }),
    };
  }
  if (input.project) {
    const teamStates = new Map<EnvironmentId, TeamEnvironmentState>();
    for (const envId of input.connectedEnvironmentIds) {
      const state = readTeamEnvironmentStateFromRegistry(appAtomRegistry, envId);
      if (state !== null && state.team !== null) {
        teamStates.set(envId, state);
      }
    }
    const assignment = resolveProjectTeamAssignment({ project: input.project, teamStates });
    if (assignment !== null) {
      return {
        teamEnvironmentId: assignment.teamEnvironmentId,
        isViewingOnLocalExecutionEnvironment: true,
        envAccess: resolveTeamThreadEnvironmentAccessForClient({
          teamState: assignment.teamState,
          threadId: input.threadId,
          viewingOnLocalExecutionEnvironment: true,
        }),
        pendingNotes: resolveTeamThreadPendingNotes({
          teamState: assignment.teamState,
          threadId: input.threadId,
        }),
        acceptedNotes: resolveTeamThreadAcceptedNotes({
          teamState: assignment.teamState,
          threadId: input.threadId,
        }),
      };
    }
  }
  return {
    teamEnvironmentId: null,
    isViewingOnLocalExecutionEnvironment: false,
    envAccess: TEAM_THREAD_ENV_ACCESS_ALLOWED,
    pendingNotes: EMPTY_NOTES,
    acceptedNotes: EMPTY_NOTES,
  };
}

const teamThreadNoteModeMapAtom = Atom.make<Readonly<Record<string, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("team:thread-note-mode"),
);

const teamThreadNoteModeForKeyAtom = Atom.family((threadKey: string) =>
  Atom.make((get): boolean => get(teamThreadNoteModeMapAtom)[threadKey] === true).pipe(
    Atom.withLabel(`team:thread-note-mode:${threadKey}`),
  ),
);

export function useTeamThreadNoteMode(threadKey: string): boolean {
  return useAtomValue(teamThreadNoteModeForKeyAtom(threadKey));
}

export function readTeamThreadNoteMode(threadKey: string): boolean {
  return appAtomRegistry.get(teamThreadNoteModeMapAtom)[threadKey] === true;
}

export function setTeamThreadNoteMode(threadKey: string, enabled: boolean): void {
  const current = appAtomRegistry.get(teamThreadNoteModeMapAtom);
  if ((current[threadKey] === true) === enabled) return;
  if (enabled) {
    appAtomRegistry.set(teamThreadNoteModeMapAtom, { ...current, [threadKey]: true });
  } else {
    const { [threadKey]: _removed, ...rest } = current;
    appAtomRegistry.set(teamThreadNoteModeMapAtom, rest);
  }
}

export interface TeamForkDialogRequest {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceThreadTitle: string;
  readonly teamEnvironmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

const teamForkDialogRequestAtom = Atom.make<TeamForkDialogRequest | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("team:fork-dialog-request"),
);

export function useTeamForkDialogRequest(): TeamForkDialogRequest | null {
  return useAtomValue(teamForkDialogRequestAtom);
}

export function openTeamForkDialog(request: TeamForkDialogRequest): void {
  appAtomRegistry.set(teamForkDialogRequestAtom, request);
}

export function closeTeamForkDialog(): void {
  appAtomRegistry.set(teamForkDialogRequestAtom, null);
}
