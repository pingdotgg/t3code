import { findThreadSearchOccurrences } from "@t3tools/client-runtime/state/thread-search";
import { useCallback, useEffect } from "react";

export const THREAD_FIND_HIGHLIGHT_NAME = "t3-thread-find";
export const THREAD_FIND_ACTIVE_HIGHLIGHT_NAME = "t3-thread-find-active";

const THREAD_FIND_TEXT_SELECTOR = "[data-thread-find-text]";
const THREAD_FIND_IGNORE_SELECTOR = "[data-thread-find-ignore]";

interface ThreadFindRange {
  readonly rowId: string;
  readonly occurrence: number;
  readonly range: Range;
}

interface HighlightConstructor {
  new (...ranges: Range[]): object;
}

interface HighlightRegistry {
  set(name: string, value: object): void;
  delete(name: string): void;
}

function resolveHighlightApi(): {
  readonly registry: HighlightRegistry;
  readonly Highlight: HighlightConstructor;
} | null {
  const css = globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined;
  const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  if (!css?.highlights || !Highlight) return null;
  return { registry: css.highlights, Highlight };
}

/** Collects visible occurrences without modifying rendered markdown. */
export function collectThreadFindRanges(container: HTMLElement, query: string): ThreadFindRange[] {
  if (query.length === 0) return [];

  const ranges: ThreadFindRange[] = [];
  const occurrenceByRowId = new Map<string, number>();

  for (const scope of container.querySelectorAll(THREAD_FIND_TEXT_SELECTOR)) {
    if (scope.parentElement?.closest(THREAD_FIND_TEXT_SELECTOR)) continue;
    const rowId = scope.closest("[data-timeline-row-id]")?.getAttribute("data-timeline-row-id");
    if (!rowId) continue;

    const walker = container.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.parentElement?.closest(THREAD_FIND_IGNORE_SELECTOR)) {
        node = walker.nextNode();
        continue;
      }

      const text = node.nodeValue ?? "";
      for (const offset of findThreadSearchOccurrences(text, query)) {
        const range = container.ownerDocument.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + query.length);
        const occurrence = occurrenceByRowId.get(rowId) ?? 0;
        ranges.push({ rowId, occurrence, range });
        occurrenceByRowId.set(rowId, occurrence + 1);
      }
      node = walker.nextNode();
    }
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

  const repaint = useCallback(() => {
    const api = resolveHighlightApi();
    if (!api) {
      onActiveRange(null);
      return;
    }
    if (!container || query.length === 0) {
      onActiveRange(null);
      api.registry.delete(THREAD_FIND_HIGHLIGHT_NAME);
      api.registry.delete(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME);
      return;
    }

    let active: Range | null = null;
    const inactive: Range[] = [];
    for (const match of collectThreadFindRanges(container, query)) {
      if (active === null && match.rowId === activeRowId && match.occurrence === activeOccurrence) {
        active = match.range;
      } else {
        inactive.push(match.range);
      }
    }
    onActiveRange(active);
    api.registry.set(THREAD_FIND_HIGHLIGHT_NAME, new api.Highlight(...inactive));
    api.registry.set(
      THREAD_FIND_ACTIVE_HIGHLIGHT_NAME,
      new api.Highlight(...(active ? [active] : [])),
    );
  }, [activeOccurrence, activeRowId, container, onActiveRange, query]);

  useEffect(() => repaint(), [repaint]);

  useEffect(() => {
    if (!container || query.length === 0) return;

    let frame: number | null = null;
    const scheduleRepaint = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        repaint();
      });
    };
    const observer = new MutationObserver(scheduleRepaint);
    observer.observe(container, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [container, query, repaint]);

  useEffect(
    () => () => {
      const api = resolveHighlightApi();
      api?.registry.delete(THREAD_FIND_HIGHLIGHT_NAME);
      api?.registry.delete(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME);
    },
    [],
  );
}
