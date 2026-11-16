import type { ReactNode, Ref } from "react";

import { cn } from "~/lib/utils";
import { AnimatedHeight } from "../AnimatedHeight";
import { ScrollArea } from "../ui/scroll-area";

const shelfNames = ["input", "working", "snoozed"] as const;

export function SidebarThreadSections({
  ref,
  main,
  shelves,
  settledMore,
  settledFixed,
  sweeping,
  dragging,
}: {
  ref: Ref<HTMLDivElement>;
  main: ReactNode;
  shelves: Record<(typeof shelfNames)[number] | "settled", readonly ReactNode[]>;
  settledMore: ReactNode;
  settledFixed: boolean;
  sweeping: boolean;
  dragging: boolean;
}) {
  const [settledHeader, ...settledRows] = shelves.settled;
  const fixedShelves = settledFixed ? [...shelfNames, "settled" as const] : shelfNames;
  const crowded = fixedShelves.filter((name) => shelves[name][0]).length > 3;
  return (
    <div
      ref={ref}
      className={cn(
        "flex min-h-0 flex-1 flex-col [container-type:size]",
        sweeping && "**:pointer-events-none",
      )}
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
        {!settledFixed ? (
          <>
            <ul role="presentation">{settledHeader}</ul>
            <AnimatedHeight>
              <ul
                data-sidebar-list="settled"
                role="presentation"
                className="relative flex flex-col gap-px"
              >
                {settledRows}
                {settledMore}
              </ul>
            </AnimatedHeight>
          </>
        ) : null}
      </ScrollArea>
      {fixedShelves.map((name) => {
        const [header, ...rows] = shelves[name];
        return (
          <div key={name} hidden={!header} className="shrink-0">
            <AnimatedHeight>
              <ul role="presentation">{header}</ul>
              <ScrollArea
                hideScrollbars
                viewportTabIndex={-1}
                className={cn(
                  "h-auto",
                  crowded
                    ? "max-h-[max(0px,calc(20cqh-2rem))]"
                    : "max-h-[max(0px,calc(28cqh-2rem))]",
                )}
              >
                <ul
                  data-sidebar-list={name}
                  role="presentation"
                  className="relative flex flex-col gap-px"
                >
                  {rows}
                  {name === "settled" ? settledMore : null}
                </ul>
              </ScrollArea>
            </AnimatedHeight>
          </div>
        );
      })}
    </div>
  );
}
