import { applyThreadPullRequestLinkUpdate } from "../threadPullRequests.ts";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  restoreSubagentBodies,
  restoreTurnItemBodies,
  type DedupedBodySource,
} from "@t3tools/shared/orchestrationV2DedupedBodies";
import {
  createOrchestrationV2TurnItemVisibility,
  isOrchestrationV2TurnItemVisible,
} from "@t3tools/shared/orchestrationV2Timeline";

export type ApplyOrchestrationV2ProjectionEventOptions = {
  readonly partialTimeline?: boolean;
  readonly latestLocalTurnOrdinal?: number | null;
};

// Only this exact pair differs at one index. Both keys are weak so hints
// neither retain streaming history nor apply to replacement snapshots.
const arrayReplacements = new WeakMap<
  ReadonlyArray<unknown>,
  WeakMap<ReadonlyArray<unknown>, number>
>();

export function getProjectionArrayReplacementIndex(
  previous: ReadonlyArray<unknown>,
  next: ReadonlyArray<unknown>,
): number | undefined {
  return arrayReplacements.get(previous)?.get(next);
}

function replaceProjectionArrayItem<T>(
  items: ReadonlyArray<T>,
  index: number,
  item: T,
): ReadonlyArray<T> {
  const next = items.slice();
  next[index] = item;
  let replacements = arrayReplacements.get(items);
  if (replacements === undefined) {
    replacements = new WeakMap();
    arrayReplacements.set(items, replacements);
  }
  replacements.set(next, index);
  return next;
}

function upsertEntity<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  item: T,
): ReadonlyArray<T> {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

// A deduped item repeats a record the stream just sent, so search newest first.
function latestBodies(projection: OrchestrationV2ThreadProjection): DedupedBodySource {
  return {
    messageText: (id) => projection.messages.findLast((message) => message.id === id)?.text,
    checkpointFiles: (id) =>
      projection.checkpoints.findLast((checkpoint) => checkpoint.id === id)?.files,
    subagent: (id) => projection.subagents.findLast((subagent) => subagent.id === id),
  };
}

function removeVisibleItem(
  rows: OrchestrationV2ThreadProjection["visibleTurnItems"],
  sourceItemId: OrchestrationV2TurnItem["id"],
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  const index = rows.findIndex((row) => row.sourceItemId === sourceItemId);
  if (index === -1) return rows;
  return renumberVisibleItems([...rows.slice(0, index), ...rows.slice(index + 1)]);
}

function renumberVisibleItems(
  rows: OrchestrationV2ThreadProjection["visibleTurnItems"],
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  return rows.map((row, position) => (row.position === position ? row : { ...row, position }));
}

function shouldShowLocalTurnItem(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
): boolean {
  return isOrchestrationV2TurnItemVisible({
    item,
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
}

function activeVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  const rows = projection.visibleTurnItems;
  const isVisible = createOrchestrationV2TurnItemVisibility({
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
  let next: Array<(typeof rows)[number]> | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const keep = row.visibility !== "local" || isVisible(row.item);
    if (!keep) {
      next ??= rows.slice(0, index);
      continue;
    }
    next?.push(row);
  }
  return next === null ? rows : renumberVisibleItems(next);
}

function oldestLocalTurnOrdinal(
  rows: OrchestrationV2ThreadProjection["visibleTurnItems"],
): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    if (row.visibility !== "local") continue;
    if (oldest === null || row.item.ordinal < oldest) {
      oldest = row.item.ordinal;
    }
  }
  return oldest;
}

const UNFINISHED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

function shouldDropMissingPartialTurnItem(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
  latestLocalTurnOrdinal: number | null | undefined,
): boolean {
  if (projection.visibleTurnItems.some((row) => row.sourceItemId === item.id)) {
    return false;
  }
  if (item.runId === null) {
    return isBelowPartialWindow(projection, item, latestLocalTurnOrdinal);
  }
  // A queued run keeps the ordinal it got when queued, so a steer sent later
  // can raise the watermark past it. Items of a run that has not finished are
  // new, not unloaded history: the first lands while the run is still queued,
  // and a bounded window can start after the ones before it.
  if (
    projection.runs.some((run) => run.id === item.runId && UNFINISHED_RUN_STATUSES.has(run.status))
  ) {
    return false;
  }
  if (
    projection.visibleTurnItems.some(
      (row) =>
        row.visibility === "local" &&
        row.item.runId === item.runId &&
        row.item.ordinal <= item.ordinal,
    )
  ) {
    return false;
  }
  return isBelowPartialWindow(projection, item, latestLocalTurnOrdinal);
}

function isBelowPartialWindow(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
  latestLocalTurnOrdinal: number | null | undefined,
): boolean {
  if (
    latestLocalTurnOrdinal !== null &&
    latestLocalTurnOrdinal !== undefined &&
    item.ordinal <= latestLocalTurnOrdinal
  ) {
    return true;
  }
  const oldest = oldestLocalTurnOrdinal(projection.visibleTurnItems);
  return oldest !== null && item.ordinal < oldest;
}

function upsertVisibleTurnItem(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
  partialTimeline: boolean,
  latestLocalTurnOrdinal: number | null | undefined,
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  const rows = projection.visibleTurnItems;
  // Streamed updates land on the newest rows. Item ids are unique, so the
  // search can start there.
  let index = rows.length - 1;
  while (index >= 0 && rows[index]!.sourceItemId !== item.id) index -= 1;
  const next = {
    position: 0,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
  const previous = index === -1 ? undefined : rows[index]!;
  if (
    previous !== undefined &&
    previous.visibility === next.visibility &&
    previous.sourceThreadId === next.sourceThreadId
  ) {
    if (previous.item === item) return rows;
    if (previous.item.ordinal === item.ordinal) {
      return replaceProjectionArrayItem(rows, index, { ...next, position: previous.position });
    }
  }
  if (
    index === -1 &&
    partialTimeline &&
    shouldDropMissingPartialTurnItem(projection, item, latestLocalTurnOrdinal)
  ) {
    return rows;
  }
  // The item goes before the first later local row, as if its old row were
  // removed first. Inserts, reorders, and inherited-to-local changes need
  // this ordering pass; replacements above preserve every other row.
  let insertion = rows.length;
  for (let candidate = 0; candidate < rows.length; candidate += 1) {
    const row = rows[candidate]!;
    if (
      candidate !== index &&
      row.visibility === "local" &&
      (row.item.ordinal > item.ordinal ||
        (row.item.ordinal === item.ordinal &&
          String(row.item.id).localeCompare(String(item.id)) > 0))
    ) {
      insertion = candidate;
      break;
    }
  }
  const updated: Array<(typeof rows)[number]> = [];
  for (let source = 0; source < rows.length; source += 1) {
    if (source === insertion) updated.push(next);
    if (source !== index) updated.push(rows[source]!);
  }
  if (insertion === rows.length) updated.push(next);
  for (let position = 0; position < updated.length; position += 1) {
    const row = updated[position]!;
    if (row.position !== position) updated[position] = { ...row, position };
  }
  return updated;
}

export function applyOrchestrationV2ProjectionEvent(
  projection: OrchestrationV2ThreadProjection | null,
  event: OrchestrationV2DomainEvent,
  options?: ApplyOrchestrationV2ProjectionEventOptions,
): OrchestrationV2ThreadProjection | null {
  if (projection === null || event.threadId !== projection.thread.id) return projection;

  const partialTimeline = options?.partialTimeline === true;
  const latestLocalTurnOrdinal = options?.latestLocalTurnOrdinal;
  const base = { ...projection, updatedAt: event.occurredAt };
  switch (event.type) {
    case "thread.pull-request-link-updated":
      return {
        ...base,
        thread: applyThreadPullRequestLinkUpdate(projection.thread, event.payload),
      };
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.auto-settle-set":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.active-reordered":
    case "thread.metadata-updated":
    case "thread.pull-request-synced":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
    case "thread.guest-share-updated":
      return { ...base, thread: event.payload };
    // Visited tracking is read state, not activity: skip the updatedAt bump.
    case "thread.visited":
    case "thread.marked-unread":
      return { ...projection, thread: event.payload };
    case "run.created":
    case "run.updated": {
      const next = { ...base, runs: upsertEntity(base.runs, event.payload) };
      return { ...next, visibleTurnItems: activeVisibleTurnItems(next) };
    }
    case "run.background-work-cancelled":
      return {
        ...base,
        runs: base.runs.map((run) =>
          run.id === event.payload.runId
            ? {
                ...run,
                restartCancelledBackgroundWork: event.payload.restartCancelledBackgroundWork,
              }
            : run,
        ),
      };
    case "run-attempt.created":
    case "run-attempt.updated": {
      const next = { ...base, attempts: upsertEntity(base.attempts, event.payload) };
      return { ...next, visibleTurnItems: activeVisibleTurnItems(next) };
    }
    case "node.updated":
      return { ...base, nodes: upsertEntity(base.nodes, event.payload) };
    case "subagent.updated":
      return {
        ...base,
        subagents: upsertEntity(
          base.subagents,
          restoreSubagentBodies(
            event.payload,
            base.subagents.find((subagent) => subagent.id === event.payload.id),
          ),
        ),
      };
    case "provider-session.attached":
    case "provider-session.updated":
      return {
        ...base,
        providerSessions: upsertEntity(base.providerSessions, event.payload),
      };
    case "provider-session.detached":
      return {
        ...base,
        providerSessions: base.providerSessions.filter(
          (session) => session.id !== event.payload.providerSessionId,
        ),
      };
    case "provider-thread.updated":
      return { ...base, providerThreads: upsertEntity(base.providerThreads, event.payload) };
    case "provider-turn.updated":
      return {
        ...base,
        providerTurns: upsertEntity(base.providerTurns, {
          ...event.payload,
          ...((event.payload.tokenUsage ??
            base.providerTurns.find((turn) => turn.id === event.payload.id)?.tokenUsage) ===
          undefined
            ? {}
            : {
                tokenUsage:
                  event.payload.tokenUsage ??
                  base.providerTurns.find((turn) => turn.id === event.payload.id)?.tokenUsage,
              }),
        }),
      };
    case "runtime-request.updated":
      return { ...base, runtimeRequests: upsertEntity(base.runtimeRequests, event.payload) };
    case "message.updated":
      return { ...base, messages: upsertEntity(base.messages, event.payload) };
    case "plan.updated":
      return { ...base, plans: upsertEntity(base.plans, event.payload) };
    case "turn-item.updated": {
      let payload = restoreTurnItemBodies(event.payload, latestBodies(projection));
      // Streamed updates land on the newest items, so search from the end.
      let itemIndex = projection.turnItems.length - 1;
      while (itemIndex >= 0 && projection.turnItems[itemIndex]!.id !== payload.id) {
        itemIndex -= 1;
      }
      const deferredWork =
        itemIndex === -1 ? undefined : projection.turnItems[itemIndex]?.deferredWork;
      if (deferredWork !== undefined) payload = { ...payload, deferredWork };
      if (
        partialTimeline &&
        itemIndex === -1 &&
        shouldDropMissingPartialTurnItem(projection, payload, latestLocalTurnOrdinal)
      ) {
        return projection;
      }
      const turnItems =
        itemIndex === -1
          ? [...projection.turnItems, payload]
          : replaceProjectionArrayItem(projection.turnItems, itemIndex, payload);
      const next = { ...base, turnItems };
      // Only interrupt requests can change another item's visibility. Streaming
      // text/tool updates must not recheck every row against every run.
      const previous = itemIndex === -1 ? undefined : projection.turnItems[itemIndex];
      const visible =
        payload.type === "run_interrupt_request" || previous?.type === "run_interrupt_request"
          ? { ...next, visibleTurnItems: activeVisibleTurnItems(next) }
          : next;
      return {
        ...next,
        visibleTurnItems: shouldShowLocalTurnItem(next, payload)
          ? upsertVisibleTurnItem(visible, payload, partialTimeline, latestLocalTurnOrdinal)
          : removeVisibleItem(visible.visibleTurnItems, payload.id),
      };
    }
    case "checkpoint-scope.created":
      return { ...base, checkpointScopes: upsertEntity(base.checkpointScopes, event.payload) };
    case "checkpoint.captured":
      return { ...base, checkpoints: upsertEntity(base.checkpoints, event.payload) };
    case "checkpoint.rollback-requested":
      return base;
    case "context-handoff.updated":
      return { ...base, contextHandoffs: upsertEntity(base.contextHandoffs, event.payload) };
    case "context-transfer.created":
    case "context-transfer.updated":
      return { ...base, contextTransfers: upsertEntity(base.contextTransfers, event.payload) };
  }
}
