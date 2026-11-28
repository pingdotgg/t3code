import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  resolveCorrelatedLocalSyncedTeamThread,
  type TeamEnvironmentState,
} from "@t3tools/client-runtime/team";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readTeamThreadLocation, teamEnvironment } from "~/state/team";

export function readTeamThreadSnoozeAccess(
  { environmentId, threadId }: ScopedThreadRef,
  registry: AtomRegistry.AtomRegistry = appAtomRegistry,
) {
  const location = readTeamThreadLocation(environmentId, threadId, registry);
  if (location === null) return null;
  const { teamState, teamEnvironmentId } = location;
  const snooze = teamState.snoozedByThreadId.get(threadId);
  const active = teamState.currentMember?.status === "active";
  return {
    teamEnvironmentId,
    snooze,
    canSnooze:
      resolveTeamThreadSnoozeEligibility(teamState, threadId) &&
      registry.get(teamEnvironment.snoozeThread.permissionAtom(teamEnvironmentId)),
    canUnsnooze:
      active &&
      snooze?.snoozedUntil != null &&
      registry.get(teamEnvironment.unsnoozeThread.permissionAtom(teamEnvironmentId)),
  };
}

export function updateTeamThreadSnooze(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  snoozedUntil: string | null,
) {
  return snoozedUntil === null
    ? runAtomCommand(registry, teamEnvironment.unsnoozeThread, {
        environmentId,
        input: { threadId },
      })
    : runAtomCommand(registry, teamEnvironment.snoozeThread, {
        environmentId,
        input: { threadId, snoozedUntil },
      });
}

export function overlayTeamThreadSnooze<T extends { readonly id: ThreadId }>(
  thread: T,
  teamState: TeamEnvironmentState | null | undefined,
): T {
  if (teamState?.team == null) return thread;
  const snooze = teamState.snoozedByThreadId.get(thread.id);
  return {
    ...thread,
    snoozedUntil: snooze?.snoozedUntil ?? null,
    snoozedAt: snooze?.snoozedAt ?? null,
    lastSnoozeWakeAt: snooze?.lastSnoozeWakeAt ?? null,
  };
}

export function overlayTeamSidebarThreadSnooze<
  T extends { readonly id: ThreadId; readonly environmentId: EnvironmentId },
>(thread: T, teamStates: ReadonlyMap<EnvironmentId, TeamEnvironmentState>): T {
  const direct = teamStates.get(thread.environmentId);
  const teamState = direct?.team
    ? direct
    : resolveCorrelatedLocalSyncedTeamThread({
        environmentId: thread.environmentId,
        threadId: thread.id,
        teamStates,
      })?.teamState;
  return overlayTeamThreadSnooze(thread, teamState);
}

export function isTeamSnoozeActive(
  teamState: TeamEnvironmentState | null | undefined,
  threadId: ThreadId,
  now: number,
): boolean {
  return Date.parse(teamState?.snoozedByThreadId.get(threadId)?.snoozedUntil ?? "") > now;
}

export function resolveTeamThreadSnoozeEligibility(
  teamState: TeamEnvironmentState,
  threadId: ThreadId,
) {
  const attribution = teamState.attributionByThreadId.get(threadId);
  const member = teamState.currentMember;
  return (
    member?.status === "active" &&
    attribution !== undefined &&
    (attribution.creatorMemberId === member.id || teamState.followedThreadIds.has(threadId))
  );
}

export function isTeamThreadSnoozedForNotification(
  teamState: TeamEnvironmentState | null | undefined,
  threadId: ThreadId,
  now: number,
): boolean {
  return (
    teamState?.followedThreadIds.has(threadId) === true &&
    isTeamSnoozeActive(teamState, threadId, now)
  );
}
