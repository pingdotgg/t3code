import {
  CONVERSATION_SUMMARY_MAX_SOURCES,
  conversationSummarySourceIdentity,
  conversationSummarySourceKey,
  type ConversationSummarySourceRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const MAX_SOURCE_CHARS = 6_000;
const MAX_PROMPT_CHARS = 32_000;
const MIN_LEAF_SOURCES = 8;

export interface SummarySource {
  readonly ref: ConversationSummarySourceRef;
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly createdAt: DateTime.Utc;
}

export const isTextBoundary = (text: string, offset: number): boolean =>
  offset === 0 ||
  offset === text.length ||
  !(
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff
  );

/** Never split a surrogate pair. A caller with fewer than two units left may make no progress. */
export const boundedTextEnd = (text: string, start: number, maxChars: number): number => {
  const end = Math.min(text.length, start + maxChars);
  return isTextBoundary(text, end) ? end : end - 1;
};

/** All of a source is represented, including long command output and message suffixes. */
export function sourceRanges(source: SummarySource): ReadonlyArray<SummarySource> {
  if (source.text.length <= MAX_SOURCE_CHARS) return [source];
  const ranges: Array<SummarySource> = [];
  for (let start = 0; start < source.text.length;) {
    const end = boundedTextEnd(source.text, start, MAX_SOURCE_CHARS);
    ranges.push({
      ...source,
      ref: { ...source.ref, range: { start, end, total: source.text.length } },
      text: source.text.slice(start, end),
    });
    start = end;
  }
  return ranges;
}

/** Consecutive uncovered ranges, with bounded model input and a small open-tail threshold. */
export function planLeafChunks(input: {
  readonly settled: ReadonlyArray<SummarySource>;
  readonly covered: ReadonlySet<string>;
}): ReadonlyArray<ReadonlyArray<SummarySource>> {
  const chunks: Array<ReadonlyArray<SummarySource>> = [];
  let index = 0;
  while (index < input.settled.length) {
    if (input.covered.has(conversationSummarySourceKey(input.settled[index]!.ref))) {
      index += 1;
      continue;
    }
    let end = index;
    while (
      end < input.settled.length &&
      !input.covered.has(conversationSummarySourceKey(input.settled[end]!.ref))
    )
      end += 1;
    const closed = end < input.settled.length;
    let start = index;
    while (start < end) {
      const chunk: Array<SummarySource> = [];
      let chars = 0;
      for (let cursor = start; cursor < end; cursor++) {
        const source = input.settled[cursor]!;
        // Include a bound for ref/role framing, in addition to the complete source range.
        const cost = source.text.length + 128;
        if (
          chunk.length >= CONVERSATION_SUMMARY_MAX_SOURCES ||
          (chunk.length > 0 && chars + cost > MAX_PROMPT_CHARS)
        )
          break;
        chunk.push(source);
        chars += cost;
      }
      const cut = start + chunk.length < end;
      // Prefer a completed reply as a cut boundary, preserving an exchange when it fits.
      const lastReply = chunk.findLastIndex(
        (source) =>
          source.role === "assistant" &&
          (source.ref.range === undefined || source.ref.range.end === source.ref.range.total),
      );
      const kept = cut && lastReply > 0 ? chunk.slice(0, lastReply + 1) : chunk;
      // A partial long source must always be finishable, even if its last range is short.
      if (
        kept.length < MIN_LEAF_SOURCES &&
        !cut &&
        !closed &&
        !kept.some((source) => source.ref.range !== undefined)
      )
        break;
      chunks.push(kept);
      start += kept.length;
    }
    index = end;
  }
  return chunks;
}

/** A handoff can omit a canonical item only when the union contains its complete source. */
export function sourcesCoverWholeItems(
  sources: ReadonlyArray<ConversationSummarySourceRef>,
): boolean {
  const groups = new Map<string, Array<ConversationSummarySourceRef>>();
  for (const source of sources) {
    const id = conversationSummarySourceIdentity(source);
    const group = groups.get(id) ?? [];
    group.push(source);
    groups.set(id, group);
  }
  return [...groups.values()].every((group) => {
    if (group.some((source) => source.digest !== group[0]!.digest)) return false;
    if (group.some((source) => source.range === undefined)) return true;
    const ranges = group.map((source) => source.range!).toSorted((a, b) => a.start - b.start);
    const total = ranges[0]!.total;
    let coveredUntil = 0;
    for (const range of ranges) {
      if (range.total !== total || range.start > coveredUntil || range.end <= range.start)
        return false;
      coveredUntil = Math.max(coveredUntil, range.end);
    }
    return coveredUntil === total;
  });
}
