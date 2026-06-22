import type {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
} from "@t3tools/contracts";

import type { OrchestrationThread } from "./connection.ts";
import { deriveWorkLogEntries, type WorkLogEntry } from "./worklog.ts";

// Build the conversation timeline the way the web UI does: messages interleaved
// with the derived work log, where CONSECUTIVE tool calls collapse into one
// "work" group that shows its most recent entry plus a "+N previous tool calls"
// expander (per-group). Plus the changed-files + working-indicator helpers. All
// pure, so the ordering is unit-tested without a renderer.

/** Most-recent work-log entries shown per group before "+N previous tool calls". */
export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;

export type TimelineRow =
  | { readonly kind: "message"; readonly id: string; readonly message: OrchestrationMessage }
  | {
      readonly kind: "work";
      readonly id: string;
      readonly createdAt: string;
      readonly groupedEntries: ReadonlyArray<WorkLogEntry>;
    };

export type TimelineEntry =
  | TimelineRow
  | { readonly kind: "separator"; readonly id: string; readonly turnNumber: number };

function rowTurnId(row: TimelineRow): string | null {
  return row.kind === "message" ? row.message.turnId : (row.groupedEntries[0]?.turnId ?? null);
}

/**
 * Insert a separator before the first row of each turn after the first, numbering
 * turns 1..N in order — so the conversation reads as distinct turns.
 */
export function withTurnSeparators(rows: ReadonlyArray<TimelineRow>): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let lastTurnId: string | null = null;
  let turnNumber = 0;
  for (const row of rows) {
    const turnId = rowTurnId(row);
    if (turnId !== null && turnId !== lastTurnId) {
      turnNumber += 1;
      if (lastTurnId !== null) {
        out.push({ kind: "separator", id: `sep:${turnId}:${turnNumber}`, turnNumber });
      }
      lastTurnId = turnId;
    }
    out.push(row);
  }
  return out;
}

interface OrderedItem {
  readonly message: OrchestrationMessage | null;
  readonly entry: WorkLogEntry | null;
  readonly createdAt: string;
}

/**
 * Interleave messages and work-log entries by createdAt, then group consecutive
 * work entries into a single "work" row (mirrors the web's deriveTimelineEntries
 * + work-group collapsing). Stable: on a timestamp tie, messages sort first.
 */
export function deriveTimelineEntries(
  messages: ReadonlyArray<OrchestrationMessage>,
  activities: OrchestrationThread["activities"],
): TimelineRow[] {
  const ordered: OrderedItem[] = [
    ...messages.map(
      (message): OrderedItem => ({ message, entry: null, createdAt: message.createdAt }),
    ),
    ...deriveWorkLogEntries(activities).map(
      (entry): OrderedItem => ({ message: null, entry, createdAt: entry.createdAt }),
    ),
  ];
  // Stable sort: equal timestamps keep messages (added first) before work entries.
  ordered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const rows: TimelineRow[] = [];
  let index = 0;
  while (index < ordered.length) {
    const item = ordered[index];
    if (!item) {
      index += 1;
      continue;
    }
    if (item.message) {
      rows.push({ kind: "message", id: item.message.id, message: item.message });
      index += 1;
      continue;
    }
    // Gather consecutive work entries into one group.
    const group: WorkLogEntry[] = [];
    let cursor = index;
    while (cursor < ordered.length && ordered[cursor]?.entry) {
      const entry = ordered[cursor]?.entry;
      if (entry) group.push(entry);
      cursor += 1;
    }
    const first = group[0];
    if (first) {
      rows.push({ kind: "work", id: first.id, createdAt: first.createdAt, groupedEntries: group });
    }
    index = cursor;
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
