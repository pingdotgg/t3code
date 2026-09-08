import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { useEffect } from "react";
import { THREAD_FIND_BLOCK_TAGS } from "@t3tools/shared/threadFindText";

const THREAD_FIND_HIGHLIGHT_NAME = "t3-thread-find";
const THREAD_FIND_ACTIVE_HIGHLIGHT_NAME = "t3-thread-find-active";

const THREAD_FIND_TEXT_SELECTOR = "[data-thread-find-text]";
const THREAD_FIND_IGNORE_SELECTOR = "[data-thread-find-ignore]";

interface ThreadFindRange {
  readonly rowId: string;
  readonly occurrence: number;
  readonly range: Range;
}

/** Collects visible occurrences without modifying rendered markdown. */
function collectThreadFindRanges(container: HTMLElement, query: string): ThreadFindRange[] {
  if (query.length === 0) return [];

  const ranges: ThreadFindRange[] = [];
  const occurrenceByRowId = new Map<string, number>();

  for (const scope of container.querySelectorAll(THREAD_FIND_TEXT_SELECTOR)) {
    if (scope.parentElement?.closest(THREAD_FIND_TEXT_SELECTOR)) continue;
    const rowId = scope.closest("[data-timeline-row-id]")?.getAttribute("data-timeline-row-id");
    if (!rowId) continue;

    let text = "";
    let nodes: { node: Node; start: number; end: number }[] = [];
    const flush = () => {
      for (const offset of findThreadSearchOccurrences(text, query)) {
        const start = nodes.find((part) => part.end > offset);
        const end = nodes.find((part) => part.end >= offset + query.length);
        if (!start || !end) continue;
        const range = container.ownerDocument.createRange();
        range.setStart(start.node, offset - start.start);
        range.setEnd(end.node, offset + query.length - end.start);
        const occurrence = occurrenceByRowId.get(rowId) ?? 0;
        ranges.push({ rowId, occurrence, range });
        occurrenceByRowId.set(rowId, occurrence + 1);
      }
      text = "";
      nodes = [];
    };
    const visit = (node: Node, inPre = false) => {
      const element = node.nodeType === 1 ? (node as Element) : null;
      if (element?.matches("svg")) return;
      if (element?.matches(`${THREAD_FIND_IGNORE_SELECTOR}, [role="toolbar"]`)) {
        flush();
        return;
      }
      const tag = element?.tagName.toLowerCase() ?? "";
      const block = THREAD_FIND_BLOCK_TAGS.has(tag);
      if (block) flush();
      if (node.nodeType === 3) {
        const value = node.nodeValue ?? "";
        const start = text.length;
        text += inPre ? value : value.replace(/\n/g, " ");
        nodes.push({ node, start, end: text.length });
      }
      for (const child of node.childNodes) visit(child, inPre || tag === "pre");
      if (block) flush();
    };
    visit(scope);
    flush();
  }
  return ranges;
}

export function useThreadFindHighlights(input: {
  readonly container: HTMLElement | null;
  readonly query: string;
  readonly activeRowId: string | null;
  readonly activeOccurrence: number;
  readonly onActiveRange: (range: Range | null) => void;
}): void {
  const { container, query, activeRowId, activeOccurrence, onActiveRange } = input;

  useEffect(() => {
    if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") {
      onActiveRange(null);
      return;
    }
    const clearHighlights = () => {
      CSS.highlights.delete(THREAD_FIND_HIGHLIGHT_NAME);
      CSS.highlights.delete(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME);
    };
    if (!container || query.length === 0) {
      onActiveRange(null);
      clearHighlights();
      return;
    }

    const repaint = () => {
      let active: Range | null = null;
      const inactive: Range[] = [];
      for (const match of collectThreadFindRanges(container, query)) {
        if (
          active === null &&
          match.rowId === activeRowId &&
          match.occurrence === activeOccurrence
        ) {
          active = match.range;
        } else {
          inactive.push(match.range);
        }
      }
      onActiveRange(active);
      CSS.highlights.set(THREAD_FIND_HIGHLIGHT_NAME, new Highlight(...inactive));
      CSS.highlights.set(
        THREAD_FIND_ACTIVE_HIGHLIGHT_NAME,
        new Highlight(...(active ? [active] : [])),
      );
    };
    repaint();

    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        repaint();
      });
    });
    observer.observe(container, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      clearHighlights();
    };
  }, [activeOccurrence, activeRowId, container, onActiveRange, query]);
}
