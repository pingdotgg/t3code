import type { CSSProperties, ReactNode } from "react";

import { useResizableWidth } from "~/hooks/useResizableWidth";

import { RightPanelResizeHandle } from "../../preview/RightPanelResizeHandle";

/** Keeps the same chapter width while a generating guide becomes a written tour. */
export function GuideChapterPanel({ children }: { children: ReactNode }) {
  const width = useResizableWidth({
    storageKey: "t3code:guide-chapter-width",
    defaultWidth: 400,
    minWidth: 280,
    maxWidth: 640,
    edge: "right",
  });

  return (
    <aside
      className="relative flex w-(--resizable-width) max-w-[50%] shrink-0 flex-col border-r border-border/60 @max-[56rem]/guide:hidden"
      style={{ "--resizable-width": `${width.width}px` } as CSSProperties}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">{children}</div>
      <RightPanelResizeHandle handlers={width.handlers} edge="right" label="Resize chapter panel" />
    </aside>
  );
}
