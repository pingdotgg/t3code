import { readAssistantText } from "~/lib/assistantTextSelection";
import type { ChatFindMatch } from "./ChatFindBar.logic";

const FIND_HIGHLIGHT_NAME = "t3-chat-find";
const FIND_ACTIVE_HIGHLIGHT_NAME = "t3-chat-find-active";

export function supportsChatFindHighlight(): boolean {
  return (
    typeof Highlight !== "undefined" && typeof CSS !== "undefined" && CSS.highlights !== undefined
  );
}

export function clearChatFindHighlights(): void {
  if (!supportsChatFindHighlight()) return;
  CSS.highlights.delete(FIND_HIGHLIGHT_NAME);
  CSS.highlights.delete(FIND_ACTIVE_HIGHLIGHT_NAME);
}

export function findChatRowTextRanges(root: HTMLElement, pattern: RegExp): Range[] {
  const stream = readAssistantText(root);
  const ranges: Range[] = [];
  for (const match of stream.text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (end <= start) continue;
    const first = stream.chunks.find((chunk) => chunk.end > start);
    const last = stream.chunks.findLast((chunk) => chunk.start < end);
    if (first === undefined || last === undefined) continue;
    const range = root.ownerDocument.createRange();
    range.setStart(first.node, Math.max(0, start - first.start));
    range.setEnd(last.node, Math.min(last.node.length, end - last.start));
    if (!range.collapsed) ranges.push(range);
  }
  return ranges;
}

export function findMountedChatRow(scrollNode: HTMLElement, rowId: string): HTMLElement | null {
  return scrollNode.querySelector<HTMLElement>(`[data-timeline-row-id="${CSS.escape(rowId)}"]`);
}

export function applyChatFindHighlights({
  scrollNode,
  pattern,
  matchRowIds,
  active,
}: {
  scrollNode: HTMLElement;
  pattern: RegExp;
  matchRowIds: ReadonlySet<string>;
  active: ChatFindMatch | null;
}): Range | null {
  if (!supportsChatFindHighlight()) return null;
  const ranges: Range[] = [];
  let activeRange: Range | null = null;
  for (const element of scrollNode.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
    const rowId = element.dataset.timelineRowId;
    if (!rowId || !matchRowIds.has(rowId)) continue;
    const rowRanges = findChatRowTextRanges(element, pattern);
    if (active !== null && rowId === active.rowId && rowRanges.length > 0) {
      activeRange = rowRanges[Math.min(active.occurrence, rowRanges.length - 1)] ?? null;
    }
    for (const range of rowRanges) {
      if (range !== activeRange) ranges.push(range);
    }
  }
  CSS.highlights.set(FIND_HIGHLIGHT_NAME, new Highlight(...ranges));
  if (activeRange) {
    CSS.highlights.set(FIND_ACTIVE_HIGHLIGHT_NAME, new Highlight(activeRange));
  } else {
    CSS.highlights.delete(FIND_ACTIVE_HIGHLIGHT_NAME);
  }
  return activeRange;
}
