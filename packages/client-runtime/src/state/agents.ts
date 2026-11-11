import { planPinnedReorder, sortActiveThreadsByOrderKey } from "./threadSort.ts";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import type { EnvironmentThreadShell } from "./shell.ts";
import { isSubagentThread } from "@t3tools/contracts";
import type { EnvironmentId, McpGatewayProfile, ThreadId } from "@t3tools/contracts";

/** Palette an agent without its own color cycles through, matching the agent editor's swatches. */
export const agentColors = ["#f5b775", "#7bb5ff", "#b797ff", "#71d8bc", "#f293b7"];

/** Stable palette color for an agent, by its position in the full profile list. */
export function agentColorFor(
  profile: Pick<McpGatewayProfile, "profileId" | "color">,
  profiles: ReadonlyArray<Pick<McpGatewayProfile, "profileId">>,
): string {
  if (profile.color) return profile.color;
  const index = profiles.findIndex((item) => item.profileId === profile.profileId);
  return agentColors[(index < 0 ? 0 : index) % agentColors.length]!;
}

export type AgentIconKey = NonNullable<McpGatewayProfile["icon"]>;

/** The legacy `icon` literals; `agentIdentity` holds the full catalog. */
const agentIconLabels: Record<AgentIconKey, string> = {
  orb: "Orb",
  bot: "Robot",
  code: "Code",
  pen: "Pen",
  search: "Search",
  shield: "Shield",
  sparkles: "Sparkles",
  terminal: "Terminal",
};

/** The glyph a client draws for an agent; missing or unrecognized icons render as the orb. */
export function agentIconKey(icon: string | null | undefined): AgentIconKey {
  return icon && Object.hasOwn(agentIconLabels, icon) ? (icon as AgentIconKey) : "orb";
}

export function groupAgentThreads(
  profiles: ReadonlyArray<McpGatewayProfile>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
) {
  const groups = new Map<string, EnvironmentThreadShell[]>(
    profiles.map((profile) => [profile.profileId, []]),
  );
  const orphaned: EnvironmentThreadShell[] = [];
  for (const thread of threads) {
    if (!thread.profileSnapshot?.profileId) continue;
    (groups.get(thread.profileSnapshot.profileId) ?? orphaned).push(thread);
  }
  for (const group of [...groups.values(), orphaned]) {
    group.sort(
      (a, b) =>
        Number(a.settledAt !== null) - Number(b.settledAt !== null) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  return { groups, orphaned };
}

/**
 * Work outside a run's own turn: "working" while a run under it is doing its
 * work, "waiting" while the only thing left is a future wake, such as a
 * scheduled run or a child waiting on checks. See selectAgentRunPendingWork.
 */
export type AgentRunPendingWork = "working" | "waiting";

/** `pendingWork`: work outside the run's own turn (see selectAgentRunPendingWork). */
export function agentThreadStatus(
  thread: EnvironmentThreadShell,
  pendingWork: AgentRunPendingWork | null = null,
) {
  if (thread.settledAt !== null) return "done";
  // Questions and approvals arrive mid-turn, so they outrank the running turn.
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
  if (thread.runtime?.status === "running" || thread.latestRun?.status === "running")
    return "running";
  if (
    thread.runtime?.status === "queued" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "preparing"
  )
    return "queued";
  if (thread.runtime?.status === "failed" || thread.latestRun?.status === "failed") return "error";
  // A turn can settle while native background work runs on: sub-agents are
  // still doing the work, while commands, monitors, and other tasks watch or wait.
  // Chats this one launched or delegated to are its work too.
  if (
    pendingWork === "working" ||
    thread.pendingBackgroundTasks.some((task) => task.kind === "subagent")
  )
    return "running";
  if (pendingWork === "waiting" || thread.pendingBackgroundTasks.length > 0) return "waiting";
  if (thread.latestRun?.status === "completed") return "done";
  return "idle";
}

export type AgentThreadStatus = ReturnType<typeof agentThreadStatus>;

export function agentThreadStatusLabel(status: AgentThreadStatus) {
  return {
    done: "Done",
    running: "In progress",
    waiting: "Waiting",
    queued: "Queued",
    idle: "Idle",
    error: "Error",
    attention: "Needs input",
  }[status];
}

export function isAgentChatInFocus(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
  selected: boolean,
) {
  if (selected) return true;
  if (thread.settledAt !== null) return false;
  const status = agentThreadStatus(thread);
  if (status !== "done") return true;
  const completedAt = thread.latestRun?.completedAt;
  if (!completedAt) return false;
  // A chat created from the board may complete before it has ever been opened.
  return (
    !lastVisitedAt ||
    !Number.isFinite(Date.parse(lastVisitedAt)) ||
    Date.parse(completedAt) > Date.parse(lastVisitedAt)
  );
}

/** The workspace keeps completed chats visible until they are explicitly settled. */
export function selectAgentWorkspaceThreads(
  threads: readonly EnvironmentThreadShell[],
  profileId: string | null,
  query: string,
) {
  const search = query.trim().toLocaleLowerCase();
  const matches = threads
    .filter(
      (thread) =>
        (Boolean(thread.profileSnapshot?.profileId) || (profileId === null && search.length > 0)) &&
        (profileId === null || thread.profileSnapshot?.profileId === profileId) &&
        (!search ||
          [thread.title, ...threadPullRequestSearchTerms(thread)].some((term) =>
            term.toLocaleLowerCase().includes(search),
          )),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    active: sortActiveThreadsByOrderKey(matches.filter((thread) => thread.settledAt === null)),
    settled: matches.filter((thread) => thread.settledAt !== null),
  };
}

/** Explicit project selections must never fall back to a different workspace. */
export function resolveAgentTaskProject<T extends { environmentId: string; id: string }>(
  projects: ReadonlyArray<T>,
  environmentId: string,
  projectId: string,
): T | undefined {
  return projects.find(
    (project) => project.environmentId === environmentId && project.id === projectId,
  );
}

const threadKey = (thread: { environmentId: string; id: string }) =>
  `${thread.environmentId}:${thread.id}`;

/**
 * Pinned chats render above every filter and search, so they are selected from
 * the full workspace rather than the filtered list. Settled chats drop out of
 * the pinned shelf: "done" beats "keep on top".
 */
export function selectPinnedAgentThreads(threads: readonly EnvironmentThreadShell[]) {
  return threads
    .filter((thread) => thread.pinnedAt != null && thread.settledAt === null)
    .sort(
      (a, b) =>
        (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "") ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
}

/** Remove already-rendered pinned chats so the filtered list cannot duplicate them. */
export function excludePinnedAgentThreads<T extends { environmentId: string; id: string }>(
  threads: readonly T[],
  pinned: readonly { environmentId: string; id: string }[],
): readonly T[] {
  if (pinned.length === 0) return threads;
  const pinnedKeys = new Set(pinned.map(threadKey));
  return threads.filter((thread) => !pinnedKeys.has(threadKey(thread)));
}

/** Move within the displayed active stack, retaining hidden threads' reserved keys. */
export function planAgentThreadMove(
  visible: readonly EnvironmentThreadShell[],
  all: readonly EnvironmentThreadShell[],
  moved: EnvironmentThreadShell,
  direction: "up" | "down",
) {
  const active = sortActiveThreadsByOrderKey(
    visible.filter((thread) => thread.settledAt === null && thread.pinnedAt == null),
  );
  const byId = new Map(active.map((thread) => [threadKey(thread), thread]));
  const orderedIds = active.map(threadKey);
  const movedId = threadKey(moved);
  const from = orderedIds.indexOf(movedId);
  const to = from + (direction === "up" ? -1 : 1);
  if (from < 0 || to < 0 || to >= orderedIds.length) return null;
  orderedIds.splice(from, 1);
  orderedIds.splice(to, 0, movedId);
  const plan = planPinnedReorder({
    orderedIds,
    keysById: new Map(all.map((thread) => [threadKey(thread), thread.activeOrderKey])),
    movedId,
  });
  return plan?.map(({ id, orderKey }) => ({ thread: byId.get(id)!, orderKey })) ?? null;
}

type AgentRun = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "parentThreadId"
  | "parentRelationship"
  | "lineage"
  | "createdAt"
  | "settledAt"
  | "pinnedAt"
  | "archivedAt"
  | "activeOrderKey"
  | "unsettledAt"
> &
  Partial<Pick<EnvironmentThreadShell, "parentEnvironmentId">>;

/** A child chat inside a card. Subagents are never here (see selectAgentSidebarThreads). */
export interface AgentChildRun<T> {
  readonly thread: T;
  /** 0 for the card's own children, 1 for their children, and so on. */
  readonly depth: number;
  /** Children sharing this one's parent, for Move up/down within that parent. */
  readonly siblings: readonly T[];
}

export interface AgentCardChildren<T> {
  /** Pinned first, then active in their arranged order, each with its own children. */
  readonly live: readonly AgentChildRun<T>[];
  /** Settled direct children (and theirs), shown last like the board's Settled shelf. */
  readonly settled: readonly AgentChildRun<T>[];
}

/**
 * A helper inside another agent's run. Subagents are never cards: they show
 * only in their owner's Lineage panel. Child chats are cards of their own.
 */
function isAgentSubagentThread(
  run: Pick<AgentRun, "lineage" | "parentThreadId" | "parentRelationship">,
) {
  return isSubagentThread(run);
}

/**
 * Every chat that is a card on the board or a row in the sidebar: everything but subagents.
 * A chat a subagent launched is listed under the nearest ancestor that is not one.
 */
export function selectAgentSidebarThreads(threads: readonly EnvironmentThreadShell[]) {
  const subagents = new Map(
    threads.filter(isAgentSubagentThread).map((thread) => [threadKey(thread), thread]),
  );
  if (subagents.size === 0) return threads;
  // A subagent's owner: its recorded parent, or for older rows its lineage parent.
  const ownerOf = (subagent: EnvironmentThreadShell) => ({
    environmentId: (subagent.parentEnvironmentId ?? subagent.environmentId) as EnvironmentId,
    id: subagent.parentThreadId ?? subagent.lineage.parentThreadId,
  });
  return threads.flatMap((thread) => {
    if (subagents.has(threadKey(thread))) return [];
    let parentKey = agentRunParentKey(thread);
    let owner: ReturnType<typeof ownerOf> | undefined;
    const seen = new Set<string>();
    for (
      let subagent = subagents.get(parentKey ?? "");
      subagent !== undefined && !seen.has(parentKey!);
      subagent = subagents.get(parentKey ?? "")
    ) {
      seen.add(parentKey!);
      owner = ownerOf(subagent);
      parentKey = owner.id === null ? null : threadKey({ ...owner, id: owner.id });
    }
    if (owner === undefined) return [thread];
    return [
      {
        ...thread,
        parentThreadId: owner.id,
        parentEnvironmentId:
          owner.environmentId === thread.environmentId ? null : owner.environmentId,
      },
    ];
  });
}

type AgentRunList = "pinned" | "active" | "settled";

/** Pinned first (latest pin on top), then active by arranged order, then settled. */
function sortSiblingRuns<T extends AgentRun>(runs: readonly T[]): T[] {
  const pinned = runs
    .filter((run) => run.pinnedAt != null && run.settledAt === null)
    .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? ""));
  const active = sortActiveThreadsByOrderKey(
    runs.filter((run) => run.pinnedAt == null && run.settledAt === null),
  );
  const settled = runs
    .filter((run) => run.settledAt !== null)
    .sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
  return [...pinned, ...active, ...settled];
}

/** Children nest under their nearest visible ancestor, across agent filters.
 * Settled cards hold only settled children so they cannot hide live work.
 * Callers exclude subagents via selectAgentSidebarThreads. */
export function nestAgentRuns<T extends AgentRun>(input: {
  readonly lists: Readonly<Record<AgentRunList, readonly T[]>>;
  readonly all: readonly T[];
}): {
  readonly lists: Readonly<Record<AgentRunList, readonly T[]>>;
  readonly childrenByKey: ReadonlyMap<string, AgentCardChildren<T>>;
} {
  const listByKey = new Map<string, AgentRunList>();
  for (const list of ["pinned", "active", "settled"] as const) {
    for (const run of input.lists[list]) listByKey.set(threadKey(run), list);
  }
  const runByKey = new Map<string, T>();
  for (const run of [...input.all, ...input.lists.pinned, ...input.lists.active]) {
    if (run.archivedAt === null) runByKey.set(threadKey(run), run);
  }
  const parentKeyOf = agentRunParentKey;
  const anchorByKey = new Map<string, string | null>();
  const resolveAnchor = (run: T, visiting: Set<string>): string | null => {
    const key = threadKey(run);
    const cached = anchorByKey.get(key);
    if (cached !== undefined) return cached;
    const parentKey = parentKeyOf(run);
    const parent = parentKey === null ? undefined : runByKey.get(parentKey);
    let anchor: string | null = null;
    if (parent && parentKey !== null && !visiting.has(parentKey)) {
      visiting.add(key);
      const candidate =
        resolveAnchor(parent, visiting) ?? (listByKey.has(parentKey) ? parentKey : null);
      visiting.delete(key);
      if (
        candidate !== null &&
        (listByKey.get(candidate) !== "settled" || run.settledAt !== null)
      ) {
        anchor = candidate;
      }
    }
    anchorByKey.set(key, anchor);
    return anchor;
  };
  const childrenByParent = new Map<string, T[]>();
  for (const run of runByKey.values()) {
    if (resolveAnchor(run, new Set()) === null) continue;
    const parentKey = parentKeyOf(run)!;
    childrenByParent.set(parentKey, [...(childrenByParent.get(parentKey) ?? []), run]);
  }
  const collect = (parentKey: string, depth: number, into: AgentChildRun<T>[]) => {
    const siblings = sortSiblingRuns(childrenByParent.get(parentKey) ?? []);
    for (const child of siblings) {
      into.push({ thread: child, depth, siblings });
      collect(threadKey(child), depth + 1, into);
    }
  };
  const childrenByKey = new Map<string, AgentCardChildren<T>>();
  for (const anchor of new Set(anchorByKey.values())) {
    if (anchor === null) continue;
    const live: AgentChildRun<T>[] = [];
    const settled: AgentChildRun<T>[] = [];
    const siblings = sortSiblingRuns(childrenByParent.get(anchor) ?? []);
    for (const child of siblings) {
      const into = child.settledAt === null ? live : settled;
      into.push({ thread: child, depth: 0, siblings });
      collect(threadKey(child), 1, into);
    }
    childrenByKey.set(anchor, { live, settled });
  }
  const keep = (runs: readonly T[]) =>
    runs.filter((run) => anchorByKey.get(threadKey(run)) == null);
  return {
    lists: {
      pinned: keep(input.lists.pinned),
      active: keep(input.lists.active),
      settled: keep(input.lists.settled),
    },
    childrenByKey,
  };
}

/**
 * A card's live children, top to bottom: questions and approvals for the user,
 * then work still in flight (running, queued, or waiting on a run, a child, or
 * a wake), then failures, idle chats, and finished ones.
 */
const AGENT_CHILD_GROUP_RANK: Record<AgentThreadStatus, number> = {
  attention: 0,
  running: 1,
  queued: 1,
  waiting: 1,
  error: 2,
  idle: 3,
  done: 4,
};

/** Child subtrees a card lists before "Show more". Ones needing input always show. */
const AGENT_CHILD_LIMIT = 8;
/** Children re-sort at most this often, so rows hold still while the user reads or clicks. */
export const AGENT_CHILD_RESORT_MS = 60_000;

/** The order a card last showed its unpinned top-level children in, and when it sorted them. */
export interface AgentChildOrder {
  readonly keys: readonly string[];
  readonly sortedAt: number;
}

/** Pinned children lead; subtrees rank by their most urgent row, then update time.
 * Between re-sorts existing rows hold still and new children slot into rank.
 * Collapsing retains attention rows beyond AGENT_CHILD_LIMIT. */
export function arrangeAgentChildRuns<
  T extends {
    readonly environmentId: string;
    readonly id: string;
    readonly updatedAt: string;
    readonly pinnedAt?: string | null | undefined;
  },
>(input: {
  readonly live: readonly AgentChildRun<T>[];
  readonly statusOf: (thread: T) => AgentThreadStatus;
  readonly previous: AgentChildOrder | null;
  readonly now: number;
  readonly expanded: boolean;
}): {
  readonly order: AgentChildOrder;
  readonly rows: readonly AgentChildRun<T>[];
  /** Rows the collapsed list hides; the list offers a toggle while this is above zero. */
  readonly overflow: number;
} {
  interface Subtree {
    readonly key: string;
    readonly top: T;
    readonly rows: AgentChildRun<T>[];
    rank: number;
  }
  const subtrees: Subtree[] = [];
  for (const child of input.live) {
    const rank = AGENT_CHILD_GROUP_RANK[input.statusOf(child.thread)];
    const last = subtrees[subtrees.length - 1];
    if (child.depth === 0 || !last) {
      subtrees.push({ key: threadKey(child.thread), top: child.thread, rows: [child], rank });
    } else {
      last.rows.push(child);
      last.rank = Math.min(last.rank, rank);
    }
  }
  const byKey = new Map(subtrees.map((subtree) => [subtree.key, subtree]));
  const pinned = subtrees.filter((subtree) => subtree.top.pinnedAt != null);
  const fresh = subtrees
    .filter((subtree) => subtree.top.pinnedAt == null)
    .sort((a, b) => a.rank - b.rank || b.top.updatedAt.localeCompare(a.top.updatedAt))
    .map((subtree) => subtree.key);
  const previous = input.previous;
  let order: AgentChildOrder;
  if (previous === null || input.now - previous.sortedAt >= AGENT_CHILD_RESORT_MS) {
    order = { keys: fresh, sortedAt: input.now };
  } else {
    const present = new Set(fresh);
    const keys = previous.keys.filter((key) => present.has(key));
    const placed = new Set(keys);
    fresh.forEach((key, index) => {
      if (placed.has(key)) return;
      // After the nearest child a fresh sort puts above this one, else first.
      let at = 0;
      for (let above = index - 1; above >= 0; above -= 1) {
        const position = keys.indexOf(fresh[above]!);
        if (position >= 0) {
          at = position + 1;
          break;
        }
      }
      keys.splice(at, 0, key);
      placed.add(key);
    });
    order =
      keys.length === previous.keys.length && keys.every((key, i) => key === previous.keys[i])
        ? previous
        : { keys, sortedAt: previous.sortedAt };
  }
  const rows: AgentChildRun<T>[] = [];
  let overflow = 0;
  [...pinned, ...order.keys.map((key) => byKey.get(key)!)].forEach((subtree, index) => {
    if (index < AGENT_CHILD_LIMIT || subtree.rank === 0) rows.push(...subtree.rows);
    else {
      overflow += subtree.rows.length;
      if (input.expanded) rows.push(...subtree.rows);
    }
  });
  return { order, rows, overflow };
}

type AgentRunLink = Pick<
  AgentRun,
  "environmentId" | "id" | "parentThreadId" | "parentEnvironmentId"
>;

/** Key of the run `run` is nested under, which may be on another environment. */
export function agentRunParentKey(
  run: Pick<AgentRunLink, "environmentId" | "id" | "parentThreadId" | "parentEnvironmentId">,
): string | null {
  if (run.parentThreadId == null) return null;
  const environmentId = run.parentEnvironmentId ?? run.environmentId;
  if (environmentId === run.environmentId && run.parentThreadId === run.id) return null;
  return threadKey({ environmentId, id: run.parentThreadId });
}

const WORKING_STATUSES = new Set(["running", "queued", "attention"]);

/** The fields of a scheduled task that tell whether it will wake a thread. */
export interface AgentScheduledWake {
  readonly environmentId: string;
  readonly task: {
    readonly enabled: boolean;
    readonly threadId: string | null;
    readonly nextRunAt: string | null;
  };
}

/** Keys of threads an enabled scheduled task will run in at a known future time. */
export function selectScheduledWakeThreadKeys(
  tasks: readonly AgentScheduledWake[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const { environmentId, task } of tasks) {
    if (task.enabled && task.threadId !== null && task.nextRunAt !== null)
      keys.add(threadKey({ environmentId, id: task.threadId }));
  }
  return keys;
}

/** Descendant work keeps a finished parent working; scheduled wakes, PR watches,
 * and other background waits keep it waiting when no descendant is working. */
export function selectAgentRunPendingWork(
  threads: readonly EnvironmentThreadShell[],
  scheduledWakeKeys: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, AgentRunPendingWork> {
  const parentKeyByKey = new Map<string, string | null>();
  for (const thread of threads) {
    if (thread.archivedAt === null)
      parentKeyByKey.set(threadKey(thread), agentRunParentKey(thread));
  }
  const pending = new Map<string, AgentRunPendingWork>();
  const waitingKeys: string[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const key = threadKey(thread);
    const status = agentThreadStatus(thread, scheduledWakeKeys.has(key) ? "waiting" : null);
    if (status === "waiting") waitingKeys.push(key);
    if (!WORKING_STATUSES.has(status)) continue;
    let parentKey = parentKeyByKey.get(key) ?? null;
    while (parentKey !== null && pending.get(parentKey) !== "working") {
      pending.set(parentKey, "working");
      parentKey = parentKeyByKey.get(parentKey) ?? null;
    }
  }
  // Working outranks waiting, so waits fill in only where nothing works. A key
  // set here has every ancestor set too, which is what lets each walk stop early.
  for (const key of waitingKeys) {
    let parentKey = parentKeyByKey.get(key) ?? null;
    while (parentKey !== null && !pending.has(parentKey)) {
      pending.set(parentKey, "waiting");
      parentKey = parentKeyByKey.get(parentKey) ?? null;
    }
  }
  for (const key of scheduledWakeKeys) {
    if (parentKeyByKey.has(key) && !pending.has(key)) pending.set(key, "waiting");
  }
  return pending;
}

/** A parent change the board shows before the server confirms it. */
export interface AgentParentOverride {
  readonly parentThreadId: ThreadId | null;
  readonly parentEnvironmentId: EnvironmentId | null;
}

/**
 * Applies pending parent changes, keyed by the child's key, so a drag or
 * "Remove from parent" lands at once. Removing an entry rolls the run back to
 * the server's link, which is the only state a failed change can leave.
 */
export function applyAgentParentOverrides<T extends EnvironmentThreadShell>(
  threads: readonly T[],
  overrides: ReadonlyMap<string, AgentParentOverride>,
): readonly T[] {
  if (overrides.size === 0) return threads;
  return threads.map((thread) => {
    const override = overrides.get(threadKey(thread));
    if (!override || agentParentOverrideApplied(thread, override)) return thread;
    return {
      ...thread,
      parentThreadId: override.parentThreadId,
      parentEnvironmentId: override.parentEnvironmentId,
    };
  });
}

/** True when the shell already shows the parent an override asked for. */
export function agentParentOverrideApplied(
  thread: Pick<AgentRun, "parentThreadId" | "parentEnvironmentId">,
  override: AgentParentOverride,
): boolean {
  return (
    (thread.parentThreadId ?? null) === override.parentThreadId &&
    (override.parentThreadId === null ||
      (thread.parentEnvironmentId ?? null) === override.parentEnvironmentId)
  );
}

/**
 * The open-chat rail lists chats in focus. Their ancestors join it so a child
 * in focus still renders inside its parent's card instead of on its own.
 */
export function withAgentRunAncestors<T extends AgentRun>(
  inFocus: readonly T[],
  all: readonly T[],
): readonly T[] {
  const byKey = new Map(all.map((run) => [threadKey(run), run]));
  const included = new Set(inFocus.map(threadKey));
  const ancestors: T[] = [];
  for (const run of inFocus) {
    let parentKey = agentRunParentKey(run);
    while (parentKey !== null && !included.has(parentKey)) {
      const parent = byKey.get(parentKey);
      if (!parent || parent.archivedAt !== null || parent.settledAt !== null) break;
      included.add(parentKey);
      ancestors.push(parent);
      parentKey = agentRunParentKey(parent);
    }
  }
  return ancestors.length === 0 ? inFocus : [...inFocus, ...ancestors];
}

/**
 * Keys of the runs `child` may become a child of, on any environment. A run cannot move
 * under itself, its current parent, or one of its own children. Computed once per drag, not
 * per pointer move.
 */
export function agentRunLinkTargets(
  child: AgentRunLink,
  all: readonly AgentRunLink[],
): ReadonlySet<string> {
  const childKeysByParent = new Map<string, string[]>();
  for (const run of all) {
    const parentKey = agentRunParentKey(run);
    if (parentKey === null) continue;
    const siblings = childKeysByParent.get(parentKey);
    if (siblings) siblings.push(threadKey(run));
    else childKeysByParent.set(parentKey, [threadKey(run)]);
  }
  const ownRuns = new Set<string>([threadKey(child)]);
  const pending: string[] = [threadKey(child)];
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    for (const childKey of childKeysByParent.get(key) ?? []) {
      if (ownRuns.has(childKey)) continue;
      ownRuns.add(childKey);
      pending.push(childKey);
    }
  }
  const currentParent = agentRunParentKey(child);
  return new Set(all.map(threadKey).filter((key) => !ownRuns.has(key) && key !== currentParent));
}

/** Why `child` cannot link under `target`, a card agentRunLinkTargets left out. */
export function agentRunLinkBlockedReason(
  child: AgentRunLink & { readonly title?: string },
  target: AgentRunLink & { readonly title: string },
): string {
  if (threadKey(child) === threadKey(target)) return "A chat cannot be its own parent";
  if (agentRunParentKey(child) === threadKey(target)) return `Already under ${target.title}`;
  return "Can't move under its own child";
}

export type AgentRunDropZone = "before" | "nest" | "after";

/** Share of a card's height, at each end, that reorders instead of linking. */
const AGENT_RUN_REORDER_EDGE = 0.25;

/**
 * Where a pointer over a card drops: the middle of the card links under that
 * run and its top and bottom edges reorder around it, so both gestures share
 * one drag. A card the run cannot link under reorders by halves, and a drag
 * that cannot reorder links anywhere on the card.
 */
export function agentRunDropZone(
  pointerY: number,
  card: { top: number; bottom: number },
  can: { nest: boolean; reorder: boolean },
): AgentRunDropZone | null {
  if (pointerY < card.top || pointerY > card.bottom) return null;
  const height = card.bottom - card.top;
  if (!can.reorder) return can.nest ? "nest" : null;
  const half = pointerY < card.top + height / 2 ? "before" : "after";
  if (!can.nest) return half;
  const edge = height * AGENT_RUN_REORDER_EDGE;
  if (pointerY < card.top + edge) return "before";
  if (pointerY > card.bottom - edge) return "after";
  return "nest";
}

/**
 * The sortable `over` id that places `activeId` before or after `targetId`.
 * dnd-kit moves the active item to `over`'s index, so the slot depends on
 * which side of the target the active item started.
 */
export function agentRunReorderOver(
  ids: readonly string[],
  activeId: string,
  targetId: string,
  zone: "before" | "after",
): string | null {
  const from = ids.indexOf(activeId);
  const target = ids.indexOf(targetId);
  if (from < 0 || target < 0) return null;
  const insertAt = zone === "before" ? target : target + 1;
  return ids[from < insertAt ? insertAt - 1 : insertAt] ?? null;
}
