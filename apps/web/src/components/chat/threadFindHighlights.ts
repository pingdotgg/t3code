import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { useEffect, useEffectEvent, useRef } from "react";
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

export function collectThreadFindRanges(container: HTMLElement, query: string): ThreadFindRange[] {
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
      let startIndex = 0;
      let endIndex = 0;
      for (const offset of findThreadSearchOccurrences(text, query)) {
        while (startIndex < nodes.length && nodes[startIndex]!.end <= offset) startIndex++;
        if (endIndex < startIndex) endIndex = startIndex;
        while (endIndex < nodes.length && nodes[endIndex]!.end < offset + query.length) endIndex++;
        const start = nodes[startIndex];
        const end = nodes[endIndex];
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
        text += inPre ? value : value.replace(/\r?\n/g, " ");
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

const FOLD_SELECTOR = "[hidden], [data-thread-find-fold]";

function foldsHiding(range: Range, container: HTMLElement): Element[] {
  const folds: Element[] = [];
  for (
    let fold = range.startContainer.parentElement?.closest(FOLD_SELECTOR);
    fold && container.contains(fold);
    fold = fold.parentElement?.closest(FOLD_SELECTOR)
  ) {
    if (
      fold.hasAttribute("hidden") ||
      range.getBoundingClientRect().bottom > fold.getBoundingClientRect().bottom
    )
      folds.push(fold);
  }
  return folds;
}

function revealFolded(range: Range, container: HTMLElement): boolean {
  const folds = foldsHiding(range, container);
  for (const fold of folds) fold.dispatchEvent(new Event("beforematch"));
  return folds.length > 0;
}

function affectsSearchableText(record: MutationRecord): boolean {
  if (record.type === "attributes") return true;
  const target =
    record.target.nodeType === 1 ? (record.target as Element) : record.target.parentElement;
  if (target?.closest(THREAD_FIND_TEXT_SELECTOR)) return true;
  const touchesScope = (node: Node) =>
    node.nodeType === 1 &&
    ((node as Element).matches(THREAD_FIND_TEXT_SELECTOR) ||
      (node as Element).querySelector(THREAD_FIND_TEXT_SELECTOR) !== null);
  return [...record.addedNodes, ...record.removedNodes].some(touchesScope);
}

export function useThreadFindHighlights(input: {
  readonly container: HTMLElement | null;
  readonly query: string;
  readonly activeRowId: string | null;
  readonly activeOccurrence: number;
  readonly onActiveRange: (range: Range | null) => void;
}): void {
  const { container, query, activeRowId, activeOccurrence, onActiveRange } = input;

  const rangesRef = useRef<readonly ThreadFindRange[]>([]);
  const paintRef = useRef<ReturnType<typeof makeThreadFindHighlightPainter> | null>(null);
  // The observer repaints with whichever match is selected when text changes.
  const readSelection = useEffectEvent(() => ({ activeRowId, activeOccurrence, onActiveRange }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints CSS Highlight ranges for the query, repainting on DOM mutations, and clears them on cleanup
  useEffect(() => {
    if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") {
      readSelection().onActiveRange(null);
      return;
    }
    const clearHighlights = () => {
      CSS.highlights.delete(THREAD_FIND_HIGHLIGHT_NAME);
      CSS.highlights.delete(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME);
    };
    rangesRef.current = [];
    if (!container || query.length === 0) {
      readSelection().onActiveRange(null);
      clearHighlights();
      return;
    }

    const cache = new Map<Element, readonly ThreadFindRange[]>();
    const paint = makeThreadFindHighlightPainter(container);
    paintRef.current = paint;
    const repaint = () => {
      const rows = new Set(container.querySelectorAll("[data-timeline-row-id]"));
      const ranges: ThreadFindRange[] = [];
      for (const row of rows) {
        let matches = cache.get(row);
        if (
          !matches ||
          matches.some(
            ({ range }) => !row.contains(range.startContainer) || !row.contains(range.endContainer),
          )
        ) {
          matches = collectThreadFindRanges(row as HTMLElement, query);
          cache.set(row, matches);
        }
        ranges.push(...matches);
      }
      for (const row of cache.keys()) if (!rows.has(row)) cache.delete(row);
      rangesRef.current = ranges;
      paint(ranges, readSelection());
    };
    let frame: number | null = null;
    const observer = new MutationObserver((mutations) => {
      // Ignore timer and status mutations outside searchable text and folds.
      const relevant = mutations.filter(affectsSearchableText);
      if (relevant.length === 0) return;
      for (const mutation of relevant) {
        const target =
          mutation.target.nodeType === 1
            ? (mutation.target as Element)
            : mutation.target.parentElement;
        const row = target?.closest("[data-timeline-row-id]");
        if (row) cache.delete(row);
      }
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        repaint();
      });
    });
    observer.observe(container, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "data-wrap",
        "hidden",
        "data-thread-find-fold",
        "data-timeline-row-id",
        "data-thread-find-text",
        "data-thread-find-ignore",
      ],
    });
    // Revealing the first match can synchronously mount or recycle list rows.
    repaint();
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      cache.clear();
      paintRef.current = null;
      rangesRef.current = [];
      clearHighlights();
    };
  }, [container, query]);

  // onActiveRange is read at paint time: its identity follows the caller's
  // layout inputs, and repainting the active highlight for those is wasted work.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- repaints the active CSS Highlight range when the selected match changes
  useEffect(() => {
    paintRef.current?.(rangesRef.current, {
      activeRowId,
      activeOccurrence,
      onActiveRange: readSelection().onActiveRange,
    });
  }, [activeOccurrence, activeRowId]);
}

function makeThreadFindHighlightPainter(container: HTMLElement) {
  let previousRanges: readonly ThreadFindRange[] | null = null;
  const rangesByRow = new Map<string, Range[]>();
  const inactive = new Highlight();
  const active = new Highlight();
  let previousActive: Range | null = null;
  CSS.highlights.set(THREAD_FIND_HIGHLIGHT_NAME, inactive);
  CSS.highlights.set(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME, active);
  return (
    ranges: readonly ThreadFindRange[],
    selection: Pick<
      Parameters<typeof useThreadFindHighlights>[0],
      "activeRowId" | "activeOccurrence" | "onActiveRange"
    >,
  ) => {
    if (previousRanges !== ranges) {
      previousRanges = ranges;
      previousActive = null;
      rangesByRow.clear();
      inactive.clear();
      for (const match of ranges) {
        const row = rangesByRow.get(match.rowId) ?? [];
        row[match.occurrence] = match.range;
        rangesByRow.set(match.rowId, row);
        if (foldsHiding(match.range, container).length === 0) inactive.add(match.range);
      }
    }
    if (previousActive && foldsHiding(previousActive, container).length === 0)
      inactive.add(previousActive);
    const selected =
      selection.activeRowId === null
        ? null
        : (rangesByRow.get(selection.activeRowId)?.[selection.activeOccurrence] ?? null);
    active.clear();
    if (selected) inactive.delete(selected);
    previousActive = selected;
    if (selected && revealFolded(selected, container)) {
      selection.onActiveRange(null);
    } else {
      if (selected) active.add(selected);
      selection.onActiveRange(selected);
    }
  };
}
