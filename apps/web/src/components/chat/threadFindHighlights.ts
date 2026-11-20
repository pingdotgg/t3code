import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { useEffect, useEffectEvent, useRef } from "react";
import { THREAD_FIND_BLOCK_TAGS } from "@t3tools/shared/threadFindText";

import { observeResize } from "~/lib/observeResize";

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
        for (const match of matches) ranges.push(match);
      }
      for (const row of cache.keys()) if (!rows.has(row)) cache.delete(row);
      rangesRef.current = ranges;
      paint.update(cache, ranges, readSelection());
    };
    let frame: number | null = null;
    let dirty = false;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (dirty) repaint();
        else paint.place(cache);
        dirty = false;
      });
    };
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
        // A hidden wrapper around rows changes their runs, which are cached with their matches.
        if (mutation.attributeName === "hidden" && target)
          for (const cached of cache.keys()) if (target.contains(cached)) cache.delete(cached);
      }
      dirty = true;
      schedule();
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
    container.addEventListener("scroll", schedule, { passive: true });
    const stopResize = observeResize(container, schedule);
    // Revealing the first match can synchronously mount or recycle list rows.
    repaint();
    return () => {
      observer.disconnect();
      stopResize();
      container.removeEventListener("scroll", schedule);
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
    paintRef.current?.select({
      activeRowId,
      activeOccurrence,
      onActiveRange: readSelection().onActiveRange,
    });
  }, [activeOccurrence, activeRowId]);
}

type ThreadFindSelection = Pick<
  Parameters<typeof useThreadFindHighlights>[0],
  "activeRowId" | "activeOccurrence" | "onActiveRange"
>;

interface TextRun {
  readonly start: number;
  end: number;
  readonly box: Element;
  readonly item: Node | null;
  readonly ordered: boolean;
  readonly hidden: boolean;
}

const INLINE_DISPLAYS = new Set(["inline", "contents"]);
const textRunsByMatches = new WeakMap<readonly ThreadFindRange[], readonly TextRun[]>();

// Splits a row's matches into runs that each lie in one inline formatting context,
// where a later match is never higher on screen. Cells, flex and grid items, and
// inline blocks each start a run, since their text can sit beside earlier text.
function textRuns(row: Element, matches: readonly ThreadFindRange[]): readonly TextRun[] {
  const cached = textRunsByMatches.get(matches);
  if (cached) return cached;
  const displays = new Map<Element, string>();
  const displayOf = (element: Element) => {
    let display = displays.get(element);
    if (display === undefined) {
      display = getComputedStyle(element).display;
      displays.set(element, display);
    }
    return display;
  };
  const columns = new Map<Element, boolean>();
  const inColumns = (element: Element): boolean => {
    let multicol = columns.get(element);
    if (multicol === undefined) {
      const style = getComputedStyle(element);
      multicol =
        style.columnCount !== "auto" ||
        style.columnWidth !== "auto" ||
        (element !== row && element.parentElement !== null && inColumns(element.parentElement));
      columns.set(element, multicol);
    }
    return multicol;
  };
  const runs: TextRun[] = [];
  let text: Node | null = null;
  for (const [index, { range }] of matches.entries()) {
    const last = runs.at(-1);
    if (last && range.startContainer === text) {
      last.end = index + 1;
      continue;
    }
    const parent = range.startContainer.parentElement;
    if (!parent) continue;
    text = range.startContainer;
    let box = parent;
    while (box !== row && box.parentElement && INLINE_DISPLAYS.has(displayOf(box)))
      box = box.parentElement;
    // Text directly inside a flex or grid container is an anonymous item of its own.
    const item = /flex|grid/.test(displayOf(box)) ? text : null;
    const hidden = parent.closest("[hidden]") !== null;
    if (last?.end === index && last.box === box && last.item === item && last.hidden === hidden) {
      last.end = index + 1;
      continue;
    }
    runs.push({ start: index, end: index + 1, box, item, hidden, ordered: !inColumns(box) });
  }
  textRunsByMatches.set(matches, runs);
  return runs;
}

// Blink rebuilds every registered highlight Range on any DOM or style change, so
// only matches within a screen of the viewport are painted; the active one always is.
function matchesInZone(
  row: Element,
  matches: readonly ThreadFindRange[],
  zone: { top: number; bottom: number },
  shown: Set<Range>,
): void {
  const rowBox = row.getBoundingClientRect();
  if (matches.length === 0 || rowBox.bottom < zone.top || rowBox.top > zone.bottom) return;
  const intersects = (rect: DOMRect) => rect.bottom >= zone.top && rect.top <= zone.bottom;
  for (const run of textRuns(row, matches)) {
    if (run.hidden) continue;
    const boxes = run.box.getClientRects();
    if (boxes.length === 0 || ![...boxes].some(intersects)) continue;
    if (!run.ordered) {
      for (let index = run.start; index < run.end; index++)
        if (intersects(matches[index]!.range.getBoundingClientRect()))
          shown.add(matches[index]!.range);
      continue;
    }
    const firstShown = (index: number, high: number): [number, DOMRect | null] => {
      for (; index < high; index++) {
        const rect = matches[index]!.range.getBoundingClientRect();
        if (rect.height > 0) return [index, rect];
      }
      return [high, null];
    };
    const firstWhere = (isPast: (rect: DOMRect) => boolean) => {
      let low = run.start;
      let high = run.end;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const [probe, rect] = firstShown(mid, high);
        if (!rect || isPast(rect)) high = mid;
        else low = probe + 1;
      }
      return low;
    };
    const end = firstWhere((rect) => rect.top > zone.bottom);
    for (let index = firstWhere((rect) => rect.bottom >= zone.top); index < end; index++)
      shown.add(matches[index]!.range);
  }
}

function makeThreadFindHighlightPainter(container: HTMLElement) {
  const inactive = new Highlight();
  const active = new Highlight();
  const zoned = new Set<Range>();
  const windows = new Map<Element, Set<Range>>();
  const rangesByRow = new Map<string, Range[]>();
  let selected: Range | null = null;
  CSS.highlights.set(THREAD_FIND_HIGHLIGHT_NAME, inactive);
  CSS.highlights.set(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME, active);
  const show = (range: Range) => {
    zoned.add(range);
    if (range !== selected && foldsHiding(range, container).length === 0) inactive.add(range);
  };
  const hide = (range: Range) => {
    zoned.delete(range);
    inactive.delete(range);
  };
  const place = (rows: ReadonlyMap<Element, readonly ThreadFindRange[]>) => {
    const viewport = container.getBoundingClientRect();
    const zone = { top: viewport.top - viewport.height, bottom: viewport.bottom + viewport.height };
    for (const [row, previous] of windows) {
      if (rows.has(row)) continue;
      for (const range of previous) hide(range);
      windows.delete(row);
    }
    for (const [row, matches] of rows) {
      const shown = new Set<Range>();
      matchesInZone(row, matches, zone, shown);
      const previous = windows.get(row);
      if (previous) for (const range of previous) if (!shown.has(range)) hide(range);
      for (const range of shown) if (!previous?.has(range)) show(range);
      windows.set(row, shown);
    }
  };
  const select = (selection: ThreadFindSelection) => {
    const next =
      selection.activeRowId === null
        ? null
        : (rangesByRow.get(selection.activeRowId)?.[selection.activeOccurrence] ?? null);
    if (selected && selected !== next && zoned.has(selected)) {
      if (foldsHiding(selected, container).length === 0) inactive.add(selected);
    }
    selected = next;
    active.clear();
    if (next) inactive.delete(next);
    if (next && revealFolded(next, container)) {
      selection.onActiveRange(null);
    } else {
      if (next) active.add(next);
      selection.onActiveRange(next);
    }
  };
  const update = (
    rows: ReadonlyMap<Element, readonly ThreadFindRange[]>,
    ranges: readonly ThreadFindRange[],
    selection: ThreadFindSelection,
  ) => {
    rangesByRow.clear();
    for (const match of ranges) {
      const row = rangesByRow.get(match.rowId) ?? [];
      row[match.occurrence] = match.range;
      rangesByRow.set(match.rowId, row);
    }
    place(rows);
    select(selection);
  };
  return { update, place, select };
}
