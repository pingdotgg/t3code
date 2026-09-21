import type { TurnId } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";

export interface ChatFindMatch {
  /** Timeline entry id; message and plan rows reuse it as their row id. */
  readonly entryId: string;
  readonly turnId: TurnId | null;
  /** Zero-based occurrence within the entry's text, in document order. */
  readonly occurrence: number;
}

export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive literal search. Whitespace in the query matches any
 * whitespace run so a phrase still matches across soft wraps and block
 * boundaries in the rendered text.
 */
export function buildChatFindPattern(query: string): RegExp | null {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;
  return new RegExp(words.map(escapeRegExp).join("\\s+"), "giu");
}

export function findPatternSpans(text: string, pattern: RegExp): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) break;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/**
 * Approximates the rendered text of a Markdown source so match counts line up
 * with what highlighting finds in the DOM: delimiters, link and image targets,
 * fences, headings and list markers are dropped while their text is kept.
 */
export function markdownSearchText(markdown: string): string {
  // Code renders literally, so its contents skip the HTML and emphasis rules.
  const literals: string[] = [];
  const keep = (text: string) => `\u0000${literals.push(text) - 1}\u0000`;
  return markdown
    .replace(/^[ \t]*(```|~~~)[^\n]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/gm, (_, _fence, body: string) =>
      keep(body),
    )
    .replace(/(`+)([^`]+?)\1/g, (_, _ticks, body: string) => keep(body))
    .replace(/^[ \t]*(```|~~~)[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/<\/?[a-zA-Z][^>\n]*>/g, "")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, "")
    .replace(/`+/g, "")
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?![\w*])/g, "$1$2")
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => literals[Number(index)] ?? "");
}

/**
 * Text a find can land on: what the conversation shows once a turn settles.
 * Thinking is grouped with tool activity behind its own disclosure and system
 * messages never render, so counting them would point at nothing.
 */
export function chatFindEntrySource(
  entry: TimelineEntry,
): { text: string; turnId: TurnId | null } | null {
  switch (entry.kind) {
    case "message":
      if (entry.message.role !== "user" && entry.message.role !== "assistant") return null;
      return { text: markdownSearchText(entry.message.text), turnId: entry.message.turnId };
    case "proposed-plan":
      return {
        text: markdownSearchText(entry.proposedPlan.planMarkdown),
        turnId: entry.proposedPlan.turnId,
      };
    default:
      return null;
  }
}

export function collectChatFindMatches(
  entries: ReadonlyArray<TimelineEntry>,
  pattern: RegExp | null,
): ChatFindMatch[] {
  if (pattern === null) return [];
  const matches: ChatFindMatch[] = [];
  for (const entry of entries) {
    const source = chatFindEntrySource(entry);
    if (source === null || source.text.length === 0) continue;
    const count = findPatternSpans(source.text, pattern).length;
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      matches.push({ entryId: entry.id, turnId: source.turnId, occurrence });
    }
  }
  return matches;
}

/**
 * Keeps the active match by identity while history loads or streams, so a
 * prepended page does not shift the selection to a different message.
 */
export function resolveActiveMatchIndex(
  matches: ReadonlyArray<ChatFindMatch>,
  active: ChatFindMatch | null,
): number {
  if (matches.length === 0) return -1;
  if (active !== null) {
    const index = matches.findIndex(
      (match) => match.entryId === active.entryId && match.occurrence === active.occurrence,
    );
    if (index >= 0) return index;
  }
  return 0;
}

export function stepChatFindIndex(index: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (index < 0) return direction === 1 ? 0 : count - 1;
  return (index + direction + count) % count;
}

export function formatChatFindCount(activeIndex: number, count: number): string {
  if (count === 0) return "No results";
  return `${activeIndex + 1}/${count}`;
}
