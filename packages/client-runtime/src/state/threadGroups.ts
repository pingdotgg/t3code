import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";

export interface ThreadGroupCandidate {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly groupParentThreadId?: ThreadId | null;
  readonly groupOrderKey?: string | null;
  readonly createdAt: string;
}

export type ThreadGroupMemberState = "live" | "snoozed" | "settled";

const SETTLED_OVERFLOW_MIN = 3;

const keyOf = (environmentId: EnvironmentId, threadId: ThreadId) =>
  scopedThreadKey(scopeThreadRef(environmentId, threadId));

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareWorkers(a: ThreadGroupCandidate, b: ThreadGroupCandidate): number {
  const aKey = a.groupOrderKey ?? null;
  const bKey = b.groupOrderKey ?? null;
  if (aKey !== bKey) {
    if (aKey === null) return 1;
    if (bKey === null) return -1;
    const byKey = compareText(aKey, bKey);
    if (byKey !== 0) return byKey;
  }
  return compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id);
}

export function splitThreadGroups<T extends ThreadGroupCandidate>(
  threads: ReadonlyArray<T>,
): {
  readonly roots: ReadonlyArray<T>;
  readonly workersByParentKey: ReadonlyMap<string, ReadonlyArray<T>>;
} {
  const known = new Set(threads.map((thread) => keyOf(thread.environmentId, thread.id)));
  const roots: T[] = [];
  const grouped = new Map<string, T[]>();
  const parentKeyOf = (thread: T) =>
    thread.groupParentThreadId ? keyOf(thread.environmentId, thread.groupParentThreadId) : null;
  const byKey = new Map(threads.map((thread) => [keyOf(thread.environmentId, thread.id), thread]));
  const isRoot = (thread: T) => {
    const parentKey = parentKeyOf(thread);
    return parentKey === null || !known.has(parentKey);
  };
  for (const thread of threads) {
    const parentKey = parentKeyOf(thread);
    const parent = parentKey === null ? undefined : byKey.get(parentKey);
    if (parentKey === null || !parent || !isRoot(parent)) {
      roots.push(thread);
      continue;
    }
    const bucket = grouped.get(parentKey);
    if (bucket) bucket.push(thread);
    else grouped.set(parentKey, [thread]);
  }
  const workersByParentKey = new Map<string, ReadonlyArray<T>>();
  for (const [key, workers] of grouped) {
    workersByParentKey.set(key, [...workers].sort(compareWorkers));
  }
  return { roots, workersByParentKey };
}

export function resolveThreadGroupFor<T extends ThreadGroupCandidate>(
  threads: ReadonlyArray<T>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): { readonly parent: T; readonly workers: ReadonlyArray<T> } | null {
  const { workersByParentKey } = splitThreadGroups(threads);
  const find = (id: ThreadId) =>
    threads.find((thread) => thread.environmentId === environmentId && thread.id === id);
  const self = find(threadId);
  if (!self) return null;
  const parent = self.groupParentThreadId ? find(self.groupParentThreadId) : undefined;
  const root =
    parent && workersByParentKey.get(keyOf(environmentId, parent.id))?.includes(self)
      ? parent
      : self;
  const workers = workersByParentKey.get(keyOf(environmentId, root.id));
  return workers && workers.length > 0 ? { parent: root, workers } : null;
}

export function resolveThreadGroupPlacement(
  states: ReadonlyArray<ThreadGroupMemberState>,
): ThreadGroupMemberState {
  if (states.includes("live")) return "live";
  if (states.includes("snoozed")) return "snoozed";
  return "settled";
}

export function resolveThreadGroupSection<S extends string>(
  parentSection: S,
  placement: ThreadGroupMemberState,
): S | "active" | "snoozed" | "settled" {
  if (placement === "settled") return "settled";
  if (placement === "snoozed") return "snoozed";
  return parentSection === "pinned" || parentSection === "working" || parentSection === "active"
    ? parentSection
    : "active";
}

export function partitionGroupWorkers<T>(
  workers: ReadonlyArray<T>,
  stateOf: (worker: T) => ThreadGroupMemberState,
): {
  readonly inline: ReadonlyArray<T>;
  readonly settledOverflow: ReadonlyArray<T>;
  readonly snoozedOverflow: ReadonlyArray<T>;
} {
  const count = (state: ThreadGroupMemberState) =>
    workers.filter((worker) => stateOf(worker) === state).length;
  const overflowSettled = count("settled") >= SETTLED_OVERFLOW_MIN;
  const overflowSnoozed = count("snoozed") >= SETTLED_OVERFLOW_MIN;
  const inline: T[] = [];
  const settledOverflow: T[] = [];
  const snoozedOverflow: T[] = [];
  for (const worker of workers) {
    const state = stateOf(worker);
    if (state === "settled" && overflowSettled) settledOverflow.push(worker);
    else if (state === "snoozed" && overflowSnoozed) snoozedOverflow.push(worker);
    else inline.push(worker);
  }
  return { inline, settledOverflow, snoozedOverflow };
}
