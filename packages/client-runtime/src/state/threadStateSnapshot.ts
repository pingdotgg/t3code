import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import { type ThreadHistoryMeta } from "./threadHistoryMerge.ts";
import { type EnvironmentThreadState, type EnvironmentThreadStatus } from "./threadState.ts";

export function statusWithoutLiveData(
  data: Option.Option<OrchestrationV2ThreadProjection>,
): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

export function historyMetaFromCachedSnapshot(
  snapshot: OrchestrationV2ThreadDetailSnapshot,
): ThreadHistoryMeta {
  const historyCursor = snapshot.historyCursor ?? null;
  const hasMoreHistory = snapshot.hasMoreHistory ?? false;
  return {
    historyCursor,
    hasMoreHistory,
    loading: false,
    error: null,
    expanded: false,
    latestLocalTurnOrdinal: snapshot.latestLocalTurnOrdinal ?? null,
  };
}

export function snapshotToPersist(
  snapshotSequence: number,
  projection: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
  acceptsBoundedSnapshots: boolean,
): OrchestrationV2ThreadDetailSnapshot {
  // A complete bounded snapshot still proves paging support. Retain that evidence
  // so a thread that grows while closed can resume with a bounded fallback.
  if (acceptsBoundedSnapshots || history.hasMoreHistory || history.historyCursor !== null) {
    return {
      snapshotSequence,
      projection,
      historyCursor: history.historyCursor,
      hasMoreHistory: history.hasMoreHistory,
      latestLocalTurnOrdinal: history.latestLocalTurnOrdinal,
    };
  }
  return { snapshotSequence, projection };
}

export function shouldPersistThread(
  thread: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
): boolean {
  // After the user loads older pages the in-memory timeline can grow large.
  // Keep those expanded projections out of the monolithic cache.
  if (history.expanded) {
    return false;
  }
  return !thread.runs.some(
    (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
  );
}

// Only still-active local copies take the server's item: events applied meanwhile win,
// and inherited rows belong to another thread.
export function settleTurnItems(
  threadId: ThreadIdType,
  projection: OrchestrationV2ThreadProjection,
  settled: ReadonlyMap<string, OrchestrationV2TurnItem>,
): OrchestrationV2ThreadProjection {
  let changed = false;
  const settle = (item: OrchestrationV2TurnItem, id: string) => {
    const server = settled.get(id);
    if (server === undefined || !isOrchestrationV2WorkActive(item.status)) return item;
    changed = true;
    return server;
  };
  const turnItems = projection.turnItems.map((item) => settle(item, item.id));
  const visibleTurnItems = projection.visibleTurnItems.map((row) => {
    if (row.sourceThreadId !== threadId) return row;
    const item = settle(row.item, row.sourceItemId);
    return item === row.item ? row : { ...row, item };
  });
  return changed ? { ...projection, turnItems, visibleTurnItems } : projection;
}

export interface ThreadResumeSnapshot {
  readonly state: EnvironmentThreadState;
  readonly sequence: number;
  readonly persisted: boolean;
  readonly acceptsBoundedSnapshots?: boolean;
}

export interface ThreadResumeCache {
  snapshot: ThreadResumeSnapshot | undefined;
  owner: object | undefined;
}

export function matchesThreadSnapshot(
  current: ThreadResumeSnapshot,
  projection: OrchestrationV2ThreadProjection | null,
  sequence: number,
  history: Pick<ThreadHistoryMeta, "historyCursor" | "hasMoreHistory" | "latestLocalTurnOrdinal">,
): boolean {
  if (current.sequence !== sequence || Option.getOrNull(current.state.data) !== projection)
    return false;
  const currentHistory = current.state.history;
  return (
    currentHistory.historyCursor === history.historyCursor &&
    currentHistory.hasMoreHistory === history.hasMoreHistory &&
    (!(history.hasMoreHistory || history.historyCursor !== null) ||
      currentHistory.latestLocalTurnOrdinal === history.latestLocalTurnOrdinal)
  );
}

export function cachedThreadState(value: EnvironmentThreadState): EnvironmentThreadState {
  return {
    ...value,
    status:
      value.status === "deleted" || (value.status === "live" && Option.isSome(value.data))
        ? value.status
        : statusWithoutLiveData(value.data),
    error: Option.none(),
    history: { ...value.history, loading: false, error: null },
  };
}
