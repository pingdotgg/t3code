import { useAtomValue } from "@effect/atom-react";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import {
  createTeamEnvironmentAtoms,
  EMPTY_TEAM_ENVIRONMENT_STATE,
  previewTeamInviteEffect,
  redeemTeamInviteAndConnectEffect,
  type TeamEnvironmentState,
  type TeamInviteJoinInput,
  type TeamInvitePreviewInput,
} from "@t3tools/client-runtime/team";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { useEnvironments } from "./environments";

const SHOW_COLLEAGUES_THREADS_STORAGE_KEY = "t3code:team:show-colleagues-threads";

function readStoredShowColleaguesThreads(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SHOW_COLLEAGUES_THREADS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStoredShowColleaguesThreads(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SHOW_COLLEAGUES_THREADS_STORAGE_KEY, value ? "true" : "false");
  } catch {
    // Ignore storage quota or private-mode errors.
  }
}

const showColleaguesThreadsAtom = Atom.make(readStoredShowColleaguesThreads()).pipe(
  Atom.keepAlive,
  Atom.withLabel("team:show-colleagues-threads"),
);

export function useShowColleaguesThreads(): boolean {
  return useAtomValue(showColleaguesThreadsAtom);
}

export function setShowColleaguesThreads(next: boolean): void {
  appAtomRegistry.set(showColleaguesThreadsAtom, next);
  writeStoredShowColleaguesThreads(next);
}

export function toggleShowColleaguesThreads(): boolean {
  const next = !appAtomRegistry.get(showColleaguesThreadsAtom);
  setShowColleaguesThreads(next);
  return next;
}

export const teamEnvironment = createTeamEnvironmentAtoms(connectionAtomRuntime);

const emptyTeamResultAtom = Atom.make<AsyncResult.AsyncResult<TeamEnvironmentState, unknown>>(
  AsyncResult.success(EMPTY_TEAM_ENVIRONMENT_STATE),
).pipe(Atom.withLabel("team:empty-state"));

const teamStatesByEnvironmentAtom = environmentAtomList("team:states", (environmentId) =>
  teamEnvironment.state(environmentId),
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
  const results = useAtomValue(teamStatesByEnvironmentAtom(environmentIdsKey(connectedIds)));
  const map = new Map<EnvironmentId, TeamEnvironmentState>();
  for (let index = 0; index < connectedIds.length; index += 1) {
    const environmentId = connectedIds[index]!;
    const result = results[index];
    if (result?._tag === "Success") {
      map.set(environmentId, result.value);
    }
  }
  return map;
}

export function useTeamThreadCreatorPseudo(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string | null {
  const state = useTeamEnvironmentState(environmentId);
  if (state.team === null) return null;
  const attribution = state.attributionByThreadId.get(threadId);
  if (!attribution) return null;
  return state.memberById.get(attribution.creatorMemberId)?.pseudo ?? attribution.creatorPseudo;
}

export const previewTeamInvite = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:team:preview-invite",
  execute: (input: TeamInvitePreviewInput) => previewTeamInviteEffect(input),
});

export const redeemTeamInvite = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:team:redeem-invite",
  execute: (input: TeamInviteJoinInput) => redeemTeamInviteAndConnectEffect(input),
});
