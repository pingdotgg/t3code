import type { ReactNode, Ref } from "react";

import { cn } from "~/lib/utils";
import { ScrollArea } from "../ui/scroll-area";

const shelfNames = ["working", "snoozed", "settled"] as const;

export function SidebarThreadSections({
  ref,
  main,
  shelves,
  settledMore,
  sweeping,
  dragging,
}: {
  ref: Ref<HTMLDivElement>;
  main: ReactNode;
  shelves: Record<(typeof shelfNames)[number], readonly ReactNode[]>;
  settledMore: ReactNode;
  sweeping: boolean;
  dragging: boolean;
}) {
  return (
    <div
      ref={ref}
      className={cn("flex min-h-0 flex-1 flex-col", sweeping && "**:pointer-events-none")}
    >
      <ScrollArea hideScrollbars viewportTabIndex={-1} className="min-h-16 flex-1">
        <ul
          data-sidebar-list="active"
          role="presentation"
          className={cn(
            "relative flex flex-col gap-px",
            // Projected drop hints must not shrink the scroll range under a held pointer.
            dragging &&
              "after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-30 after:h-px after:content-['']",
          )}
        >
          {main}
        </ul>
      </ScrollArea>
      {shelfNames.map((name) => {
        const [header, ...rows] = shelves[name];
        return (
          <div key={name} hidden={!header} className="flex max-h-[28%] min-h-8 shrink flex-col">
            <ul role="presentation" className="shrink-0">
              {header}
            </ul>
            <ScrollArea hideScrollbars viewportTabIndex={-1} className="h-auto min-h-0 shrink">
              <ul
                data-sidebar-list={name}
                role="presentation"
                className="relative flex flex-col gap-px"
              >
                {rows}
                {name === "settled" ? settledMore : null}
              </ul>
            </ScrollArea>
          </div>
        );
      })}
    </div>
  );
}
