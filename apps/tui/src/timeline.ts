import type {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
} from "@t3tools/contracts";

import type { OrchestrationThread } from "./connection.ts";
import { deriveWorkLogEntries, type WorkLogEntry } from "./worklog.ts";

// Build the conversation timeline the way the web UI does: messages interleaved
// with the derived work log, then collapsed at two levels.
//   1. CONSECUTIVE tool calls collapse into one "work" group that shows its most
//      recent entry plus a "+N previous tool calls" expander (per-group).
//   2. Every SETTLED turn folds its commentary + tool work behind a single
//      "Worked for <duration>" row, leaving only the final assistant message
//      visible; the latest unsettled (running) turn stays fully expanded so its
//      work streams live.
// Plus the changed-files + working-indicator helpers. All pure, so the ordering
// and folding are unit-tested without a renderer.

/** Most-recent work-log entries shown per group before "+N previous tool calls". */
export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;

/** Rows that can live both at top level and inside a collapsed turn fold. */
export type FoldableRow =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly message: OrchestrationMessage;
    }
  | {
      readonly kind: "work";
      readonly id: string;
      readonly createdAt: string;
      readonly groupedEntries: ReadonlyArray<WorkLogEntry>;
    };

export type TimelineRow =
  | FoldableRow
  | {
      readonly kind: "turn-fold";
      readonly id: string;
      readonly turnId: string;
      readonly createdAt: string;
      readonly label: string;
      readonly hiddenRows: ReadonlyArray<FoldableRow>;
    };

type LatestTurn = OrchestrationThread["latestTurn"];

interface OrderedItem {
  readonly id: string;
  readonly createdAt: string;
  readonly turnId: string | null;
  readonly message: OrchestrationMessage | null;
  readonly entry: WorkLogEntry | null;
}

/** Whole/partial-second elapsed label, matching the web's formatDuration buckets. */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIso(a: string | null, b: string): string {
  if (a === null) return b;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

/** The latest turn is unsettled while it is still running or hasn't recorded a completion. */
function unsettledTurnId(latestTurn: LatestTurn): string | null {
  if (!latestTurn) return null;
  const settled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return settled ? null : latestTurn.turnId;
}

/** The last assistant message of each turn (keyed by turnId, or by position for null-turn replies). */
function terminalAssistantMessageIds(ordered: ReadonlyArray<OrderedItem>): Set<string> {
  const lastByResponseKey = new Map<string, string>();
  let nullTurnIndex = 0;
  for (const item of ordered) {
    if (!item.message) continue;
    if (item.message.role === "user") {
      nullTurnIndex += 1;
      continue;
    }
    if (item.message.role !== "assistant") continue;
    const key = item.turnId ? `turn:${item.turnId}` : `unkeyed:${nullTurnIndex}`;
    lastByResponseKey.set(key, item.message.id);
  }
  return new Set(lastByResponseKey.values());
}

/** Group a contiguous run of ordered items into rows, merging consecutive work entries. */
function groupRows(items: ReadonlyArray<OrderedItem>): FoldableRow[] {
  const rows: FoldableRow[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (!item) {
      index += 1;
      continue;
    }
    if (item.message) {
      rows.push({ kind: "message", id: item.id, createdAt: item.createdAt, message: item.message });
      index += 1;
      continue;
    }
    const group: WorkLogEntry[] = [];
    let cursor = index;
    while (cursor < items.length && items[cursor]?.entry) {
      const entry = items[cursor]?.entry;
      if (entry) group.push(entry);
      cursor += 1;
    }
    const first = group[0];
    if (first) rows.push({ kind: "work", id: first.id, createdAt: first.createdAt, groupedEntries: group });
    index = cursor;
  }
  return rows;
}

interface TurnFold {
  readonly turnId: string;
  readonly label: string;
  readonly hiddenIds: ReadonlySet<string>;
  readonly hiddenRows: ReadonlyArray<FoldableRow>;
}

/**
 * For each settled turn, fold everything but its terminal assistant message
 * behind a "Worked for <duration>" row anchored at the turn's first entry.
 */
function deriveTurnFolds(
  ordered: ReadonlyArray<OrderedItem>,
  latestTurn: LatestTurn,
): Map<string, TurnFold> {
  const terminalIds = terminalAssistantMessageIds(ordered);
  const unsettled = unsettledTurnId(latestTurn);

  interface Group {
    items: OrderedItem[];
    startBoundary: string | null;
    terminalId: string | null;
    hasStreaming: boolean;
  }
  const groups = new Map<string, Group>();
  let pendingUserBoundary: string | null = null;
  for (const item of ordered) {
    if (item.message?.role === "user") {
      pendingUserBoundary = item.createdAt;
      continue;
    }
    if (!item.turnId) continue;
    let group = groups.get(item.turnId);
    if (!group) {
      group = { items: [], startBoundary: pendingUserBoundary, terminalId: null, hasStreaming: false };
      pendingUserBoundary = null;
      groups.set(item.turnId, group);
    }
    group.items.push(item);
    if (item.message) {
      if (terminalIds.has(item.message.id)) group.terminalId = item.message.id;
      if (item.message.streaming) group.hasStreaming = true;
    }
  }

  const folds = new Map<string, TurnFold>();
  for (const [turnId, group] of groups) {
    if (turnId === unsettled || group.hasStreaming) continue;
    const hidden = group.items.filter((item) => item.message?.id !== group.terminalId);
    if (hidden.length === 0) continue;
    const first = group.items[0];
    const last = group.items.at(-1);
    if (!first || !last) continue;

    const lastEnd = last.message ? last.message.updatedAt : last.createdAt;
    const terminalUpdatedAt =
      group.items.find((item) => item.message?.id === group.terminalId)?.message?.updatedAt ?? null;
    const elapsedMs =
      latestTurn?.turnId === turnId && latestTurn.startedAt && latestTurn.completedAt
        ? computeElapsedMs(latestTurn.startedAt, latestTurn.completedAt)
        : computeElapsedMs(group.startBoundary ?? first.createdAt, maxIso(terminalUpdatedAt, lastEnd));
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const interrupted = latestTurn?.turnId === turnId && latestTurn.state === "interrupted";
    const label = interrupted
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    folds.set(first.id, {
      turnId,
      label,
      hiddenIds: new Set(hidden.map((item) => item.id)),
      hiddenRows: groupRows(hidden),
    });
  }
  return folds;
}

/**
 * Interleave messages and work-log entries by createdAt, group consecutive tool
 * calls, and fold settled turns behind a "Worked for <duration>" row. Stable: on
 * a timestamp tie, messages sort before work entries.
 */
export function deriveTimelineEntries(
  messages: ReadonlyArray<OrchestrationMessage>,
  activities: OrchestrationThread["activities"],
  latestTurn: LatestTurn = null,
): TimelineRow[] {
  const ordered: OrderedItem[] = [
    ...messages.map(
      (message): OrderedItem => ({
        id: message.id,
        createdAt: message.createdAt,
        turnId: message.turnId,
        message,
        entry: null,
      }),
    ),
    ...deriveWorkLogEntries(activities).map(
      (entry): OrderedItem => ({
        id: entry.id,
        createdAt: entry.createdAt,
        turnId: entry.turnId,
        message: null,
        entry,
      }),
    ),
  ];
  // Stable sort: equal timestamps keep messages (added first) before work entries.
  ordered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const folds = deriveTurnFolds(ordered, latestTurn);
  const collapsed = new Set<string>();
  for (const fold of folds.values()) {
    for (const id of fold.hiddenIds) collapsed.add(id);
  }

  const rows: TimelineRow[] = [];
  let index = 0;
  while (index < ordered.length) {
    const item = ordered[index];
    if (!item) {
      index += 1;
      continue;
    }
    const fold = folds.get(item.id);
    if (fold) {
      rows.push({
        kind: "turn-fold",
        id: `turn-fold:${fold.turnId}`,
        turnId: fold.turnId,
        createdAt: item.createdAt,
        label: fold.label,
        hiddenRows: fold.hiddenRows,
      });
    }
    if (collapsed.has(item.id)) {
      index += 1;
      continue;
    }
    if (item.message) {
      rows.push({ kind: "message", id: item.id, createdAt: item.createdAt, message: item.message });
      index += 1;
      continue;
    }
    // Gather consecutive, non-collapsed work entries into one group.
    const group: WorkLogEntry[] = [];
    let cursor = index;
    while (cursor < ordered.length) {
      const next = ordered[cursor];
      if (!next?.entry || collapsed.has(next.id) || folds.has(next.id)) break;
      group.push(next.entry);
      cursor += 1;
    }
    const first = group[0];
    if (first) {
      rows.push({ kind: "work", id: first.id, createdAt: first.createdAt, groupedEntries: group });
      index = cursor;
    } else {
      index += 1;
    }
  }
  return rows;
}

// ── Working indicator ────────────────────────────────────────────────────────

export function isWorking(detail: OrchestrationThread): boolean {
  return detail.session?.status === "running" || detail.latestTurn?.state === "running";
}

export function workingStartedAt(detail: OrchestrationThread): string | null {
  return detail.latestTurn?.startedAt ?? null;
}

/** Whole seconds elapsed since the active turn started, or null if unknown. */
export function workingElapsedSeconds(startedAt: string | null, nowMs: number): number | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  return Math.max(0, Math.floor((nowMs - started) / 1000));
}

// ── Changed files ────────────────────────────────────────────────────────────

export interface DiffStat {
  readonly additions: number;
  readonly deletions: number;
}

export function diffStat(files: OrchestrationCheckpointSummary["files"]): DiffStat {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

/** Checkpoints ordered newest-first, for the revert picker. */
export function revertableCheckpoints(
  checkpoints: OrchestrationThread["checkpoints"],
): OrchestrationCheckpointSummary[] {
  return [...checkpoints].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
}

/**
 * Latest checkpoint (with at least one file) per assistant message id, so the
 * conversation can render a "Changed files" summary under the message that
 * produced them — mirroring the web timeline.
 */
export function changedFilesByMessage(
  checkpoints: OrchestrationThread["checkpoints"],
): Map<string, OrchestrationCheckpointSummary> {
  const byMessage = new Map<string, OrchestrationCheckpointSummary>();
  const ordered = [...checkpoints].sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  for (const checkpoint of ordered) {
    if (!checkpoint.assistantMessageId || checkpoint.files.length === 0) continue;
    byMessage.set(checkpoint.assistantMessageId, checkpoint);
  }
  return byMessage;
}
