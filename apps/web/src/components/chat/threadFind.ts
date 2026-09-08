import type { TurnId } from "@t3tools/contracts";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import type { TimelineEntry } from "../../session-logic";
import { searchableMessageSegments, searchablePlanSegments } from "@t3tools/shared/threadFindText";

/** One occurrence of the query inside a searchable timeline entry. */
export interface ThreadFindMatch {
  readonly entryId: string;
  /** The turn to expand when the matching entry is folded. */
  readonly turnId: TurnId | null;
  /** Zero-based occurrence within this timeline entry. */
  readonly occurrence: number;
}

// Message/plan records are immutable and survive timeline rebuilds during streaming.
// Weak keys reuse parsed text across keystrokes without retaining old messages.
const entryTextCache = new WeakMap<object, readonly string[] | null>();

function searchableThreadEntrySegments(entry: TimelineEntry): readonly string[] | null {
  if (entry.kind !== "message" && entry.kind !== "proposed-plan") return null;
  const key = entry.kind === "message" ? entry.message : entry.proposedPlan;
  let segments = entryTextCache.get(key);
  if (segments === undefined) {
    segments =
      entry.kind === "message"
        ? searchableMessageSegments(entry.message)
        : searchablePlanSegments(entry.proposedPlan.planMarkdown);
    entryTextCache.set(key, segments);
  }
  return segments;
}

/** Conversation text only: source-only Markdown and generated controls are excluded. */
export function searchableThreadEntryText(entry: TimelineEntry): string | null {
  return searchableThreadEntrySegments(entry)?.join("\n") ?? null;
}

function threadEntryTurnId(entry: TimelineEntry): TurnId | null {
  if (entry.kind === "message") return entry.message.turnId ?? null;
  if (entry.kind === "proposed-plan") return entry.proposedPlan.turnId;
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
    const segments = searchableThreadEntrySegments(entry);
    if (segments === null) continue;

    const total = segments.reduce(
      (count, text) => count + countThreadSearchOccurrences(text, normalizedQuery),
      0,
    );
    for (let occurrence = 0; occurrence < total; occurrence += 1) {
      matches.push({
        entryId: entry.id,
        turnId: threadEntryTurnId(entry),
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
