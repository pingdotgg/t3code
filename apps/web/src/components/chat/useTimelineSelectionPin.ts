import type { AlwaysRenderConfig } from "@legendapp/list/react";
import { useEffect, useMemo, useState } from "react";

/** The rows holding the two ends of a text selection that starts in the timeline. */
export interface TimelineSelectionPin {
  readonly anchorRowId: string;
  readonly focusRowId: string;
}

/** The id of the timeline row a selection endpoint sits in, or null outside any row. */
function timelineRowIdOfNode(node: Node | null): string | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest<HTMLElement>("[data-timeline-row-id]")?.dataset.timelineRowId ?? null;
}

/**
 * Adds every row from the selection's anchor through its focus, in either
 * direction, to the list's always-rendered rows. Unrendered rows would drop
 * out of the native selection and take its anchor with them.
 */
export function pinSelectedTimelineRows(
  rows: ReadonlyArray<{ readonly id: string }>,
  pin: TimelineSelectionPin | null,
  alwaysRender: AlwaysRenderConfig | undefined,
): AlwaysRenderConfig | undefined {
  if (pin === null) return alwaysRender;
  const anchorIndex = rows.findIndex((row) => row.id === pin.anchorRowId);
  const focusIndex = rows.findIndex((row) => row.id === pin.focusRowId);
  if (anchorIndex < 0 || focusIndex < 0) return alwaysRender;
  const indices = new Set(alwaysRender?.indices);
  for (
    let index = Math.min(anchorIndex, focusIndex);
    index <= Math.max(anchorIndex, focusIndex);
    index++
  ) {
    indices.add(index);
  }
  return { ...alwaysRender, indices: [...indices].sort((a, b) => a - b) };
}

/**
 * Keeps the rows under a timeline text selection mounted while it exists.
 * State changes only when the selection enters a different row, not on every
 * selectionchange, and clears once the selection collapses or leaves.
 */
export function useTimelineSelectionPin({
  viewport,
  rows,
  alwaysRender,
}: {
  viewport: HTMLElement | null;
  rows: ReadonlyArray<{ readonly id: string }>;
  alwaysRender: AlwaysRenderConfig | undefined;
}): AlwaysRenderConfig | undefined {
  const [pin, setPin] = useState<TimelineSelectionPin | null>(null);

  useEffect(() => {
    if (!viewport) return;
    const document = viewport.ownerDocument;
    const onSelectionChange = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || !viewport.contains(selection.anchorNode)) {
        setPin(null);
        return;
      }
      const anchorRowId = timelineRowIdOfNode(selection.anchorNode);
      if (anchorRowId === null) {
        setPin(null);
        return;
      }
      // A focus outside any row (a gap, the composer) keeps the last row it was in.
      const focusRowId = viewport.contains(selection.focusNode)
        ? timelineRowIdOfNode(selection.focusNode)
        : null;
      setPin((current) => {
        const nextFocusRowId =
          focusRowId ?? (current?.anchorRowId === anchorRowId ? current.focusRowId : anchorRowId);
        return current?.anchorRowId === anchorRowId && current.focusRowId === nextFocusRowId
          ? current
          : { anchorRowId, focusRowId: nextFocusRowId };
      });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [viewport]);

  return useMemo(() => pinSelectedTimelineRows(rows, pin, alwaysRender), [alwaysRender, pin, rows]);
}
