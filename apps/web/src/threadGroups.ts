import type { GitStatusResult } from "@t3tools/contracts";
import { formatWorktreePathForDisplay } from "./worktreeCleanup";

export type ThreadGroupId = string;
export const MAIN_THREAD_GROUP_ID: ThreadGroupId = "main";

export interface ThreadGroupIdentity {
  branch: string | null;
  worktreePath: string | null;
}

export interface ThreadGroupSeed extends ThreadGroupIdentity {
  createdAt: string;
}

export interface OrderedProjectThreadGroup {
  id: ThreadGroupId;
  branch: string | null;
  worktreePath: string | null;
  label: string;
  latestActivityAt: string;
}

export type ThreadGroupPrStatus = GitStatusResult["pr"];

function normalizeWorktreePath(worktreePath: string): string {
  return worktreePath.trim();
}

function normalizeBranchName(branch: string): string {
  return branch.trim();
}

function normalizeProjectThreadGroupOrder(threadGroupOrder: readonly ThreadGroupId[]): ThreadGroupId[] {
  const seen = new Set<ThreadGroupId>();
  const next: ThreadGroupId[] = [];
  for (const groupId of threadGroupOrder) {
    if (groupId === MAIN_THREAD_GROUP_ID || seen.has(groupId)) {
      continue;
    }
    seen.add(groupId);
    next.push(groupId);
  }
  return next;
}

export function buildThreadGroupId(input: ThreadGroupIdentity): ThreadGroupId {
  if (input.worktreePath) {
    return `worktree:${normalizeWorktreePath(input.worktreePath)}`;
  }
  if (input.branch) {
    return `branch:${normalizeBranchName(input.branch)}`;
  }
  return MAIN_THREAD_GROUP_ID;
}

function threadGroupLabel(input: ThreadGroupIdentity): string {
  if (input.worktreePath) {
    return input.branch ?? formatWorktreePathForDisplay(input.worktreePath);
  }
  if (input.branch) {
    return input.branch;
  }
  return "Main";
}

export function orderProjectThreadGroups<T extends ThreadGroupSeed>(input: {
  threads: T[];
  orderedGroupIds?: readonly ThreadGroupId[] | null | undefined;
}): OrderedProjectThreadGroup[] {
  const groups = new Map<string, OrderedProjectThreadGroup>();
  for (const thread of input.threads) {
    const id = buildThreadGroupId({
      branch: thread.branch,
      worktreePath: thread.worktreePath,
    });
    const existing = groups.get(id);
    if (!existing) {
      groups.set(id, {
        id,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        label: threadGroupLabel({
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        }),
        latestActivityAt: thread.createdAt,
      });
      continue;
    }
    if (thread.createdAt > existing.latestActivityAt) {
      existing.latestActivityAt = thread.createdAt;
    }
  }

  const mainGroup =
    groups.get(MAIN_THREAD_GROUP_ID) ??
    ({
      id: MAIN_THREAD_GROUP_ID,
      branch: null,
      worktreePath: null,
      label: "Main",
      latestActivityAt: "",
    } satisfies OrderedProjectThreadGroup);

  const nonMainGroups = [...groups.values()].filter((group) => group.id !== MAIN_THREAD_GROUP_ID);
  const normalizedProjectThreadGroupOrder = normalizeProjectThreadGroupOrder(input.orderedGroupIds ?? []);
  const orderedKnownIds = new Set(normalizedProjectThreadGroupOrder);
  const newGroups = nonMainGroups
    .filter((group) => !orderedKnownIds.has(group.id))
    .toSorted((left, right) => right.latestActivityAt.localeCompare(left.latestActivityAt));
  const knownGroups = normalizedProjectThreadGroupOrder
    .map((groupId) => groups.get(groupId))
    .filter((group): group is OrderedProjectThreadGroup => group !== undefined);

  return [mainGroup, ...newGroups, ...knownGroups];
}

export function reorderProjectThreadGroupOrder(input: {
  currentOrder: ThreadGroupId[];
  movedGroupId: ThreadGroupId;
  beforeGroupId: ThreadGroupId | null;
}): ThreadGroupId[] {
  const normalizedCurrentOrder = normalizeProjectThreadGroupOrder(input.currentOrder);
  if (input.movedGroupId === MAIN_THREAD_GROUP_ID) {
    return normalizedCurrentOrder;
  }
  const withoutMoved = normalizedCurrentOrder.filter((groupId) => groupId !== input.movedGroupId);
  if (input.beforeGroupId === MAIN_THREAD_GROUP_ID) {
    return [input.movedGroupId, ...withoutMoved];
  }
  if (!input.beforeGroupId) {
    return [...withoutMoved, input.movedGroupId];
  }
  const insertIndex = withoutMoved.indexOf(input.beforeGroupId);
  if (insertIndex === -1) {
    return [input.movedGroupId, ...withoutMoved];
  }
  return [
    ...withoutMoved.slice(0, insertIndex),
    input.movedGroupId,
    ...withoutMoved.slice(insertIndex),
  ];
}

export function resolveProjectThreadGroupPrById(input: {
  groups: readonly OrderedProjectThreadGroup[];
  projectCwd: string;
  statusByCwd: ReadonlyMap<string, GitStatusResult>;
}): Map<ThreadGroupId, ThreadGroupPrStatus> {
  const prByGroupId = new Map<ThreadGroupId, ThreadGroupPrStatus>();

  for (const group of input.groups) {
    if (group.id === MAIN_THREAD_GROUP_ID || group.branch === null) {
      prByGroupId.set(group.id, null);
      continue;
    }

    const cwd = group.worktreePath ?? input.projectCwd;
    const status = input.statusByCwd.get(cwd);
    const branchMatches = status?.branch !== null && status?.branch === group.branch;
    prByGroupId.set(group.id, branchMatches ? (status?.pr ?? null) : null);
  }

  return prByGroupId;
}
