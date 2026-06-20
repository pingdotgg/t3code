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
