import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

export function CompactSidebarPreview({
  railEnabled,
  compactRows,
}: {
  railEnabled: boolean;
  compactRows: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const sidebarRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = sidebarRef.current?.animate(
      [
        { width: "36px", offset: 0 },
        { width: railEnabled ? "12px" : "0px", offset: 0.45 },
        { width: railEnabled ? "12px" : "0px", offset: 0.6 },
        { width: "36px", offset: 1 },
      ],
      { duration: 800, easing: "ease-in-out" },
    );
    return () => animation?.cancel();
  }, [railEnabled, compactRows]);

  return (
    <button
      type="button"
      aria-label="Toggle compact sidebar preview"
      aria-pressed={collapsed}
      className="group/compact-preview relative flex h-10 w-full cursor-pointer overflow-hidden rounded-lg border border-border bg-background p-1 shadow-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      onClick={() => {
        sidebarRef.current?.getAnimations().forEach((animation) => animation.cancel());
        setCollapsed((value) => !value);
      }}
    >
      <span
        ref={sidebarRef}
        aria-hidden
        className={cn(
          "flex h-full shrink-0 flex-col justify-center gap-1 overflow-hidden rounded-md bg-sidebar transition-[width] duration-250 ease-out motion-reduce:transition-none",
          collapsed ? (railEnabled ? "w-3" : "w-0") : "w-9",
        )}
      >
        {(compactRows ? [0, 1, 2, 3] : [0, 1, 2]).map((row) => (
          <span key={row} className="flex shrink-0 items-start gap-1 px-1">
            <span className="size-1 shrink-0 rounded-[1px] bg-muted-foreground/50" />
            <span
              className={cn(
                "flex shrink-0 flex-col gap-0.5 transition-opacity duration-250 ease-out motion-reduce:transition-none",
                collapsed && "opacity-0",
              )}
            >
              <span className="h-0.5 w-4 rounded-full bg-muted-foreground/25" />
              {!compactRows && <span className="h-0.5 w-2 rounded-full bg-muted-foreground/15" />}
            </span>
          </span>
        ))}
      </span>
      <span aria-hidden className="flex min-w-0 flex-1 flex-col gap-1 px-1 pt-1">
        <span className="h-0.5 w-full rounded-full bg-muted-foreground/25" />
        <span className="h-0.5 w-4/5 rounded-full bg-muted-foreground/20" />
        <span className="h-0.5 w-3/5 rounded-full bg-muted-foreground/15" />
      </span>
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-3 left-5 flex w-9 flex-col gap-1 rounded-sm border border-border bg-popover p-1 opacity-0 shadow-xs transition-opacity duration-150 ease-out motion-reduce:transition-none",
          collapsed &&
            railEnabled &&
            "group-hover/compact-preview:opacity-100 group-focus-visible/compact-preview:opacity-100",
        )}
      >
        <span className="h-0.5 w-full rounded-full bg-popover-foreground/45" />
        <span className="h-0.5 w-2/3 rounded-full bg-popover-foreground/25" />
      </span>
    </button>
  );
}
