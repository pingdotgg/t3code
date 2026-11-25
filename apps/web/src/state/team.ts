import { useAtomValue } from "@effect/atom-react";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import {
  createTeamEnvironmentAtoms,
  EMPTY_TEAM_ENVIRONMENT_STATE,
  isFollowingTeamThread,
  isTeamColleagueThread,
  previewTeamInviteEffect,
  redeemTeamInviteAndConnectEffect,
  type TeamEnvironmentState,
  type TeamInviteJoinInput,
  type TeamInvitePreviewInput,
} from "@t3tools/client-runtime/team";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { useEnvironments } from "./environments";

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

const teamThreadCreatorPseudoAtom = Atom.family((threadKey: string) =>
  Atom.make((get): string | null => {
    const separatorIndex = threadKey.indexOf("\0");
    if (separatorIndex === -1) return null;
    const environmentId = threadKey.slice(0, separatorIndex) as EnvironmentId;
    const threadId = threadKey.slice(separatorIndex + 1) as ThreadId;
    const result = get(teamEnvironment.state(environmentId));
    if (result._tag !== "Success" || result.value.team === null) return null;
    const attribution = result.value.attributionByThreadId.get(threadId);
    if (!attribution) return null;
    return (
      result.value.memberById.get(attribution.creatorMemberId)?.pseudo ?? attribution.creatorPseudo
    );
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

export const previewTeamInvite = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:team:preview-invite",
  execute: (input: TeamInvitePreviewInput) => previewTeamInviteEffect(input),
});

export const redeemTeamInvite = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:team:redeem-invite",
  execute: (input: TeamInviteJoinInput) => redeemTeamInviteAndConnectEffect(input),
});
