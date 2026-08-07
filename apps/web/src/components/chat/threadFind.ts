import type { RunAttemptId, RunId } from "@t3tools/contracts";
import { findThreadSearchOccurrences } from "@t3tools/client-runtime/state/thread-search";
import type { TimelineEntry } from "../../session-logic";
import { stripDisplayedPlanMarkdown } from "../../proposedPlan";
import { deriveDisplayedUserMessageContent } from "~/lib/visibleMessageText";
import { formatInlineTerminalContextLabel } from "./userMessageTerminalContexts";

/** One occurrence of the query inside a searchable timeline entry. */
export interface ThreadFindMatch {
  readonly entryId: string;
  /** V2 run ownership, used to reveal a match inside a folded settled run. */
  readonly runId: RunId | null;
  /** V2 attempt ownership, used to reveal superseded-attempt output. */
  readonly attemptId: RunAttemptId | null;
  /** Zero-based occurrence within this timeline entry. */
  readonly occurrence: number;
}

/**
 * Returns the conversation text represented by an entry. Work and lifecycle
 * rows are intentionally excluded.
 */
export function searchableThreadEntryText(entry: TimelineEntry): string | null {
  if (entry.kind === "proposed-plan") {
    return stripDisplayedPlanMarkdown(entry.proposedPlan.planMarkdown);
  }
  if (entry.kind !== "message") return null;
  if (entry.message.role === "user") {
    const displayed = deriveDisplayedUserMessageContent(entry.message.text);
    return displayed.terminalContexts.reduce(
      (text, context) => text.replaceAll(formatInlineTerminalContextLabel(context.header), ""),
      displayed.visibleText,
    );
  }
  if (entry.message.role !== "assistant") return null;
  return entry.message.text || (entry.message.streaming ? "" : "(empty response)");
}

function threadEntryRunId(entry: TimelineEntry): RunId | null {
  if (entry.attempt) return entry.attempt.runId;
  if (entry.kind === "message") return entry.message.runId;
  if (entry.kind === "proposed-plan") return entry.proposedPlan.runId;
  return null;
}

export function buildThreadFindMatches(
  entries: ReadonlyArray<TimelineEntry>,
  query: string,
): ThreadFindMatch[] {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) return [];

  const matches: ThreadFindMatch[] = [];
  for (const entry of entries) {
    const text = searchableThreadEntryText(entry);
    if (text === null) continue;

    const offsets = findThreadSearchOccurrences(text, normalizedQuery);
    for (let occurrence = 0; occurrence < offsets.length; occurrence += 1) {
      matches.push({
        entryId: entry.id,
        runId: threadEntryRunId(entry),
        attemptId: entry.attempt?.id ?? null,
        occurrence,
      });
    }
  }
  return matches;
}

export function clampThreadFindIndex(index: number, total: number): number {
  if (total <= 0 || !Number.isFinite(index) || index < 0) return 0;
  return Math.min(Math.trunc(index), total - 1);
}

export function stepThreadFindIndex(index: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  const clamped = clampThreadFindIndex(index, total);
  return (((clamped + delta) % total) + total) % total;
}

export function formatThreadFindCount(index: number, total: number): string {
  return total <= 0 ? "0/0" : `${clampThreadFindIndex(index, total) + 1}/${total}`;
}
