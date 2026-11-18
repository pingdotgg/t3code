import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";

const CURVE_RADIUS = 8;

export interface SidebarThreadGroupProps {
  readonly expanded: boolean;
  readonly trunkX: number;
  readonly branchEndX: number;
  readonly trunkTopOffset: number;
  readonly children: ReactNode;
}

function measureAnchorCentres(container: HTMLElement): number[] {
  const top = container.getBoundingClientRect().top;
  return Array.from(container.querySelectorAll("[data-thread-group-anchor]"), (anchor) => {
    const box = anchor.getBoundingClientRect();
    return box.top - top + box.height / 2;
  });
}

function buildTreePath(
  centres: readonly number[],
  trunkX: number,
  branchEndX: number,
  trunkTopOffset: number,
): string {
  const last = centres.at(-1);
  if (last === undefined) return "";
  const segments = [
    `M ${trunkX} ${-trunkTopOffset} V ${last - CURVE_RADIUS} Q ${trunkX} ${last} ${trunkX + CURVE_RADIUS} ${last} H ${branchEndX}`,
  ];
  for (const centre of centres.slice(0, -1)) {
    segments.push(
      `M ${trunkX} ${centre - CURVE_RADIUS} Q ${trunkX} ${centre} ${trunkX + CURVE_RADIUS} ${centre} H ${branchEndX}`,
    );
  }
  return segments.join(" ");
}

export function SidebarThreadGroup(props: SidebarThreadGroupProps) {
  const { expanded, trunkX, branchEndX, trunkTopOffset, children } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [centres, setCentres] = useState<readonly number[]>([]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- anchor centres exist only in the laid-out DOM, so the tree path is measured after layout and whenever the container resizes
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      // A collapsing group keeps its path until the panel has shut, so workers never slide away without their line.
      const next = expanded
        ? measureAnchorCentres(container)
        : container.getBoundingClientRect().height === 0
          ? []
          : null;
      if (next === null) return;
      setCentres((previous) =>
        previous.length === next.length && previous.every((value, index) => value === next[index])
          ? previous
          : next,
      );
    };
    update();
    return observeResize(container, update);
  }, [expanded]);

  const path = buildTreePath(centres, trunkX, branchEndX, trunkTopOffset);

  return (
    <Collapsible open={expanded}>
      <div ref={containerRef} className="relative">
        {path ? (
          // Clipped to the panel's current height, so a growing group never draws past its last row.
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 overflow-hidden"
            style={{ top: -trunkTopOffset }}
          >
            <svg className="size-full" fill="none">
              <path
                d={path}
                transform={`translate(0 ${trunkTopOffset})`}
                className="stroke-muted-foreground/50"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        ) : null}
        <CollapsiblePanel>{children}</CollapsiblePanel>
      </div>
    </Collapsible>
  );
}

export function SidebarThreadGroupOverflowRow(props: {
  kind: "settled" | "snoozed";
  count: number;
  onExpand: () => void;
  expanded?: boolean;
  onCollapse?: () => void;
  /** Folder rows draw the branch further right, so the label starts where worker titles do. */
  inFolder?: boolean;
}) {
  const showingLess = props.expanded === true;
  return (
    <button
      type="button"
      className={cn(
        "block w-full cursor-pointer py-1 pe-2 text-left text-xs text-muted-foreground hover:text-foreground",
        props.inFolder ? "ps-15" : "ps-2.5",
      )}
      onClick={showingLess ? props.onCollapse : props.onExpand}
    >
      {showingLess ? (
        "Show less"
      ) : (
        <span data-thread-group-anchor>
          +{props.count} {props.kind}
        </span>
      )}
    </button>
  );
}
