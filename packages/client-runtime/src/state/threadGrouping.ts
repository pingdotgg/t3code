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

export type WorkerStatus = "needs-input" | "working" | "idle";

export interface ThreadGroup<T> {
  readonly leader: T;
  readonly workers: ReadonlyArray<T>;
  /** A worker is working or waiting on the user, so the group belongs in Active. */
  readonly live: boolean;
  /** The leader is a Bot that mutes its workers: only workers needing input surface. */
  readonly muted: boolean;
}

export interface GroupedThreads<T> {
  /** Leaders and ungrouped threads, in input order; worker rows show under their leader. */
  readonly listed: ReadonlyArray<T>;
  readonly groupByLeaderKey: ReadonlyMap<string, ThreadGroup<T>>;
}

const keyOf = (thread: Pick<GroupableThread, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export function workerStatus(thread: GroupableThread): WorkerStatus {
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
 * Groups workers under their leader, one level deep. Workers whose leader is missing from `threads`
 * (archived, filtered out) or settled keep their own row: settling or archiving a Bot lets its
 * workers go, and reopening it takes them back.
 */
export function groupThreads<T extends GroupableThread>(
  threads: ReadonlyArray<T>,
): GroupedThreads<T> {
  const byKey = new Map(threads.map((thread) => [keyOf(thread), thread] as const));
  const workersByLeader = new Map<string, T[]>();
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
    const workers = workersByLeader.get(leaderKey);
    if (workers === undefined) workersByLeader.set(leaderKey, [thread]);
    else workers.push(thread);
  }
  const workerKeys = new Set<string>();
  const groupByLeaderKey = new Map<string, ThreadGroup<T>>();
  for (const [leaderKey, workers] of workersByLeader) {
    const leader = byKey.get(leaderKey)!;
    for (const member of workers) workerKeys.add(keyOf(member));
    groupByLeaderKey.set(leaderKey, {
      leader,
      workers,
      live: workers.some((member) => workerStatus(member) !== "idle"),
      muted: leader.botConfig?.muteChildren === true,
    });
  }
  return {
    listed: threads.filter((thread) => !workerKeys.has(keyOf(thread))),
    groupByLeaderKey,
  };
}

/** Whether a worker's updates (unread marks, notifications) reach the user. */
export function workerSurfaces<T extends GroupableThread>(
  member: T,
  group: Pick<ThreadGroup<T>, "muted">,
): boolean {
  return !group.muted || workerStatus(member) === "needs-input";
}

export interface FoldedWorkersSummary<T> {
  readonly count: number;
  /** One status per worker, needing input first, then working. */
  readonly statuses: ReadonlyArray<WorkerStatus>;
  /** Workers that stay visible while folded: those needing input. */
  readonly alwaysVisible: ReadonlyArray<T>;
}

const STATUS_ORDER: Record<WorkerStatus, number> = { "needs-input": 0, working: 1, idle: 2 };

export function foldedWorkersSummary<T extends GroupableThread>(
  group: Pick<ThreadGroup<T>, "workers">,
): FoldedWorkersSummary<T> {
  const statuses = group.workers.map(workerStatus);
  return {
    count: group.workers.length,
    statuses: [...statuses].sort((left, right) => STATUS_ORDER[left] - STATUS_ORDER[right]),
    alwaysVisible: group.workers.filter((_, index) => statuses[index] === "needs-input"),
  };
}

/** The worker rows a group shows: all when unfolded, only those needing input when folded. */
export function visibleWorkers<T extends GroupableThread>(
  group: Pick<ThreadGroup<T>, "workers">,
  folded: boolean,
): ReadonlyArray<T> {
  return folded
    ? group.workers.filter((member) => workerStatus(member) === "needs-input")
    : group.workers;
}

/** A Bot's workers by what each needs; archived workers are left out. */
export interface BotWorkersBoard<T> {
  readonly needsYou: ReadonlyArray<T>;
  readonly working: ReadonlyArray<T>;
  readonly done: ReadonlyArray<T>;
}

export interface BotGroups<T> {
  /** Unarchived Bots, oldest first, so rows keep their places. */
  readonly bots: ReadonlyArray<T>;
  readonly boardByBotKey: ReadonlyMap<string, BotWorkersBoard<T>>;
  /** Bots and their workers: they live on the Bot's own page, not in the thread list. */
  readonly botAndWorkerKeys: ReadonlySet<string>;
}

const EMPTY_BOARD: BotWorkersBoard<never> = { needsYou: [], working: [], done: [] };

export function groupBots<
  T extends GroupableThread & Pick<EnvironmentThreadShell, "archivedAt" | "createdAt">,
>(threads: ReadonlyArray<T>): BotGroups<T> {
  const bots = threads
    .filter((thread) => thread.botConfig != null && thread.archivedAt === null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const boards = new Map<string, { needsYou: T[]; working: T[]; done: T[] }>(
    bots.map((bot) => [keyOf(bot), { needsYou: [], working: [], done: [] }] as const),
  );
  const botAndWorkerKeys = new Set(boards.keys());
  for (const thread of threads) {
    const botId = thread.groupedUnderThreadId;
    if (botId == null || botId === thread.id) continue;
    const board = boards.get(scopedThreadKey(scopeThreadRef(thread.environmentId, botId)));
    if (board === undefined) continue;
    botAndWorkerKeys.add(keyOf(thread));
    if (thread.archivedAt !== null) continue;
    const status = workerStatus(thread);
    (status === "needs-input"
      ? board.needsYou
      : status === "working"
        ? board.working
        : board.done
    ).push(thread);
  }
  return { bots, boardByBotKey: boards, botAndWorkerKeys };
}

export function botWorkersBoard<T>(
  groups: Pick<BotGroups<T>, "boardByBotKey">,
  botKey: string,
): BotWorkersBoard<T> {
  return groups.boardByBotKey.get(botKey) ?? EMPTY_BOARD;
}
