import { readAssistantText, type RenderedTextChunk } from "../../lib/assistantTextSelection";
import { findPatternSpans, type TextSpan } from "./ChatFind.logic";

export const CHAT_FIND_HIGHLIGHT_NAME = "t3-chat-find";
export const CHAT_FIND_ACTIVE_HIGHLIGHT_NAME = "t3-chat-find-active";

export function supportsChatFindHighlights(): boolean {
  return (
    typeof Highlight !== "undefined" && typeof CSS !== "undefined" && CSS.highlights !== undefined
  );
}

export interface ChunkBoundary<TChunk> {
  readonly chunk: TChunk;
  readonly offset: number;
}

/**
 * Maps a span in the rendered text stream back to its first and last text
 * chunks. Block separators live between chunks, so a span that begins or ends
 * on one is clamped to the neighbouring text node.
 */
export function resolveChunkBoundaries<TChunk extends { start: number; end: number }>(
  chunks: ReadonlyArray<TChunk>,
  span: TextSpan,
): { start: ChunkBoundary<TChunk>; end: ChunkBoundary<TChunk> } | null {
  const first = chunks.find((chunk) => chunk.end > span.start);
  const last = chunks.findLast((chunk) => chunk.start < span.end);
  if (first === undefined || last === undefined || first.start >= span.end) return null;
  return {
    start: { chunk: first, offset: Math.max(0, span.start - first.start) },
    end: { chunk: last, offset: Math.min(last.end - last.start, span.end - last.start) },
  };
}

/** Ranges for every match rendered inside `root`, in document order. */
export function collectChatFindRanges(root: HTMLElement, pattern: RegExp): Range[] {
  const stream = readAssistantText(root);
  const ranges: Range[] = [];
  for (const span of findPatternSpans(stream.text, pattern)) {
    const boundaries = resolveChunkBoundaries<RenderedTextChunk>(stream.chunks, span);
    if (boundaries === null) continue;
    const range = root.ownerDocument.createRange();
    range.setStart(boundaries.start.chunk.node, boundaries.start.offset);
    range.setEnd(boundaries.end.chunk.node, boundaries.end.offset);
    if (!range.collapsed) ranges.push(range);
  }
  return ranges;
}

/** Painting thousands of one-letter hits per frame is not worth the cost; the counter stays exact. */
const MAX_PAINTED_RANGES = 2000;

export function paintChatFindHighlights(ranges: ReadonlyArray<Range>, active: Range | null): void {
  if (!supportsChatFindHighlights()) return;
  const highlight = new Highlight();
  for (const range of ranges.slice(0, MAX_PAINTED_RANGES)) highlight.add(range);
  CSS.highlights.set(CHAT_FIND_HIGHLIGHT_NAME, highlight);
  if (active) {
    CSS.highlights.set(CHAT_FIND_ACTIVE_HIGHLIGHT_NAME, new Highlight(active));
  } else {
    CSS.highlights.delete(CHAT_FIND_ACTIVE_HIGHLIGHT_NAME);
  }
}

export function clearChatFindHighlights(): void {
  if (!supportsChatFindHighlights()) return;
  CSS.highlights.delete(CHAT_FIND_HIGHLIGHT_NAME);
  CSS.highlights.delete(CHAT_FIND_ACTIVE_HIGHLIGHT_NAME);
}
