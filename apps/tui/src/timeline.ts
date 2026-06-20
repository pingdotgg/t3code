import type {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
} from "@t3tools/contracts";

import type { OrchestrationThread } from "./connection.ts";
import { deriveWorkLog, type WorkLogEntry } from "./worklog.ts";

// Build the conversation timeline the way the web UI does: messages and the
// derived work log (tool calls / thinking) interleaved in chronological order,
// plus the helpers backing the changed-files summary and the working indicator.
// All pure, so the ordering + working math are unit-tested without a renderer.

export type TimelineRow =
  | { readonly kind: "message"; readonly id: string; readonly message: OrchestrationMessage }
  | { readonly kind: "tool"; readonly id: string; readonly entry: WorkLogEntry };

export type TimelineEntry =
  | TimelineRow
  | { readonly kind: "separator"; readonly id: string; readonly turnNumber: number };

export type FoldedEntry =
  | TimelineEntry
  | { readonly kind: "folded"; readonly id: string; readonly hiddenCount: number };

function rowTurnId(row: TimelineRow): string | null {
  return row.kind === "message" ? row.message.turnId : row.entry.turnId;
}

/**
 * Collapse runs of consecutive tool rows to their last `recent`, replacing the
 * earlier ones with a single "folded" marker — progressive disclosure for long
 * turns (mirrors the web work-log's "first N + show more"). A no-op when expanded.
 */
export function foldWorkLog(
  entries: ReadonlyArray<TimelineEntry>,
  options: { readonly collapsed: boolean; readonly recent: number },
): FoldedEntry[] {
  if (!options.collapsed) return [...entries];
  const out: FoldedEntry[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    if (!entry || entry.kind !== "tool") {
      if (entry) out.push(entry);
      index += 1;
      continue;
    }
    let end = index;
    while (end < entries.length && entries[end]?.kind === "tool") end += 1;
    const run = entries.slice(index, end);
    if (run.length > options.recent) {
      const hiddenCount = run.length - options.recent;
      out.push({ kind: "folded", id: `fold:${run[0]?.id ?? index}`, hiddenCount });
      out.push(...run.slice(hiddenCount));
    } else {
      out.push(...run);
    }
    index = end;
  }
  return out;
}

/**
 * Insert a separator before the first row of each turn after the first, numbering
 * turns 1..N in order — so the conversation reads as distinct turns (mirrors the
 * web timeline's turn folds).
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

interface OrderedRow {
  readonly row: TimelineRow;
  readonly createdAt: string;
}

/** Interleave messages and work-log entries by createdAt (stable: ties keep messages first). */
export function buildTimeline(
  messages: ReadonlyArray<OrchestrationMessage>,
  activities: OrchestrationThread["activities"],
): TimelineRow[] {
  const ordered: OrderedRow[] = [
    ...messages.map(
      (message): OrderedRow => ({
        row: { kind: "message", id: message.id, message },
        createdAt: message.createdAt,
      }),
    ),
    ...deriveWorkLog(activities).map(
      (entry): OrderedRow => ({
        row: { kind: "tool", id: entry.id, entry },
        createdAt: entry.createdAt,
      }),
    ),
  ];
  // Array.prototype.sort is stable, so equal timestamps keep the message-before-tool
  // insertion order above.
  ordered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return ordered.map((item) => item.row);
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
