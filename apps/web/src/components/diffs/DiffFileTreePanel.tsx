import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "~/hooks/useResizableWidth";
import { observeResize } from "~/lib/observeResize";

import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";

export function DiffFileTreePanel({
  children,
  defaultWidth = 256,
  minWidth = 160,
}: {
  children: ReactNode;
  defaultWidth?: number;
  minWidth?: number;
}) {
  const hostRef = useRef<HTMLElement>(null);
  const [maxWidth, setMaxWidth] = useState(640);

  useLayoutEffect(() => {
    const row = hostRef.current?.parentElement;
    if (!row) return;
    // Leave at least half the row for the diff, including in narrow preview panels.
    const measure = () => setMaxWidth(Math.max(minWidth, Math.min(640, row.clientWidth / 2)));
    measure();
    return observeResize(row, measure);
  }, [minWidth]);

  const { width, handlers } = useResizableWidth({
    storageKey: "t3code:diff-file-tree-width",
    defaultWidth,
    minWidth,
    maxWidth,
    edge: "left",
  });

  return (
    <aside
      ref={hostRef}
      className="relative flex w-(--resizable-width) min-w-0 shrink-0 border-l border-border/60"
      style={{ [RESIZABLE_WIDTH_PROPERTY]: `${width}px` } as CSSProperties}
    >
      <RightPanelResizeHandle handlers={handlers} className="touch-none" />
      {children}
    </aside>
  );
}
