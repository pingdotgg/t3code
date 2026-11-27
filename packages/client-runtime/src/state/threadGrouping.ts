import type { EnvironmentThreadShell } from "./models.ts";
import { threadRuntimeIsActive } from "./models.ts";
import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";

export type GroupableThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "groupedUnderThreadId"
  | "botConfig"
  | "settledOverride"
  | "runtime"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
>;

export type CrewStatus = "needs-input" | "working" | "idle";

export interface ThreadGroup<T> {
  readonly leader: T;
  readonly crew: ReadonlyArray<T>;
  /** A crew member is working or waiting on the user, so the group belongs in Active. */
  readonly live: boolean;
  /** The leader is a Bot that mutes its crew: only crew needing input surface. */
  readonly muted: boolean;
}

export interface GroupedThreads<T> {
  /** Leaders and ungrouped threads, in input order; crew rows show under their leader. */
  readonly listed: ReadonlyArray<T>;
  readonly groupByLeaderKey: ReadonlyMap<string, ThreadGroup<T>>;
}

const keyOf = (thread: Pick<GroupableThread, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export function crewStatus(thread: GroupableThread): CrewStatus {
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingSubagentRequest != null ||
    (thread.pendingGuestMessageCount ?? 0) > 0
  ) {
    return "needs-input";
  }
  return threadRuntimeIsActive(thread.runtime) ? "working" : "idle";
}

/**
 * Groups crew under their leader, one level deep. Crew whose leader is missing from `threads`
 * (archived, filtered out) or settled keep their own row: settling or archiving a Bot lets its
 * crew go, and reopening it takes them back.
 */
export function groupThreads<T extends GroupableThread>(
  threads: ReadonlyArray<T>,
): GroupedThreads<T> {
  const byKey = new Map(threads.map((thread) => [keyOf(thread), thread] as const));
  const crewByLeader = new Map<string, T[]>();
  for (const thread of threads) {
    const leaderId = thread.groupedUnderThreadId;
    if (leaderId == null || leaderId === thread.id) continue;
    const leaderKey = scopedThreadKey(scopeThreadRef(thread.environmentId, leaderId));
    const leader = byKey.get(leaderKey);
    if (
      leader === undefined ||
      leader.groupedUnderThreadId != null ||
      leader.settledOverride === "settled"
    ) {
      continue;
    }
    const crew = crewByLeader.get(leaderKey);
    if (crew === undefined) crewByLeader.set(leaderKey, [thread]);
    else crew.push(thread);
  }
  const crewKeys = new Set<string>();
  const groupByLeaderKey = new Map<string, ThreadGroup<T>>();
  for (const [leaderKey, crew] of crewByLeader) {
    const leader = byKey.get(leaderKey)!;
    for (const member of crew) crewKeys.add(keyOf(member));
    groupByLeaderKey.set(leaderKey, {
      leader,
      crew,
      live: crew.some((member) => crewStatus(member) !== "idle"),
      muted: leader.botConfig?.muteChildren === true,
    });
  }
  return {
    listed: threads.filter((thread) => !crewKeys.has(keyOf(thread))),
    groupByLeaderKey,
  };
}

/** Whether a crew member's updates (unread marks, notifications) reach the user. */
export function crewMemberSurfaces<T extends GroupableThread>(
  member: T,
  group: Pick<ThreadGroup<T>, "muted">,
): boolean {
  return !group.muted || crewStatus(member) === "needs-input";
}

export interface FoldedCrewSummary<T> {
  readonly count: number;
  /** One status per crew member, needing input first, then working. */
  readonly statuses: ReadonlyArray<CrewStatus>;
  /** Crew that stay visible while folded: those needing input. */
  readonly alwaysVisible: ReadonlyArray<T>;
}

const STATUS_ORDER: Record<CrewStatus, number> = { "needs-input": 0, working: 1, idle: 2 };

export function foldedCrewSummary<T extends GroupableThread>(
  group: Pick<ThreadGroup<T>, "crew">,
): FoldedCrewSummary<T> {
  const statuses = group.crew.map(crewStatus);
  return {
    count: group.crew.length,
    statuses: [...statuses].sort((left, right) => STATUS_ORDER[left] - STATUS_ORDER[right]),
    alwaysVisible: group.crew.filter((_, index) => statuses[index] === "needs-input"),
  };
}

/** The crew rows a group shows: all when unfolded, only those needing input when folded. */
export function visibleCrew<T extends GroupableThread>(
  group: Pick<ThreadGroup<T>, "crew">,
  folded: boolean,
): ReadonlyArray<T> {
  return folded ? group.crew.filter((member) => crewStatus(member) === "needs-input") : group.crew;
}
