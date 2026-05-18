import { useEffect, type RefObject } from "react";

/**
 * Applies CSS Custom Highlight API highlighting to all visible text matching
 * `query` inside `containerRef`. Automatically re-applies when the DOM changes
 * (e.g. virtual list scrolling) via MutationObserver.
 *
 * Uses two highlight registrations:
 *  - `chat-find`        — all matches (yellow)
 *  - `chat-find-active`  — the single active match (orange)
 *
 * Style these with `::highlight(chat-find)` / `::highlight(chat-find-active)`
 * in CSS.
 */
export function useChatFindHighlight(
  containerRef: RefObject<HTMLElement | null>,
  query: string,
  activeMatchRowId: string | null,
  activeMatchIndexInRow: number,
): void {
  useEffect(() => {
    if (typeof CSS === "undefined" || !CSS.highlights) {
      return;
    }

    const container = containerRef.current;
    const normalizedQuery = query.trim().toLowerCase();

    if (!container || normalizedQuery.length === 0) {
      CSS.highlights.delete("chat-find");
      CSS.highlights.delete("chat-find-active");
      return;
    }

    function applyHighlights(): void {
      const allRanges: Range[] = [];
      const activeRanges: Range[] = [];

      // Group text nodes by their owning timeline row so we can track
      // per-row match indices for active-match identification.
      const rowElements = container!.querySelectorAll<HTMLElement>("[data-timeline-row-id]");

      for (const rowEl of rowElements) {
        const rowId = rowEl.getAttribute("data-timeline-row-id");
        const isActiveRow = rowId === activeMatchRowId;
        let matchCountInRow = 0;

        const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const textNode = walker.currentNode as Text;
          const text = textNode.textContent?.toLowerCase() ?? "";
          let startPos = 0;

          while (startPos < text.length) {
            const index = text.indexOf(normalizedQuery, startPos);
            if (index === -1) break;

            const range = new Range();
            range.setStart(textNode, index);
            range.setEnd(textNode, index + normalizedQuery.length);
            allRanges.push(range);

            if (isActiveRow && matchCountInRow === activeMatchIndexInRow) {
              activeRanges.push(range);
            }

            matchCountInRow++;
            startPos = index + normalizedQuery.length;
          }
        }
      }

      if (allRanges.length > 0) {
        CSS.highlights.set("chat-find", new Highlight(...allRanges));
      } else {
        CSS.highlights.delete("chat-find");
      }

      if (activeRanges.length > 0) {
        CSS.highlights.set("chat-find-active", new Highlight(...activeRanges));
      } else {
        CSS.highlights.delete("chat-find-active");
      }
    }

    applyHighlights();

    // Re-apply whenever the DOM subtree changes (virtual list recycling).
    const observer = new MutationObserver(applyHighlights);
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      observer.disconnect();
      CSS.highlights.delete("chat-find");
      CSS.highlights.delete("chat-find-active");
    };
  }, [containerRef, query, activeMatchRowId, activeMatchIndexInRow]);
}
