import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";

import { LayoutPaneSkeleton, PaneNotchTab } from "../../layout/PaneSkeleton";
import { cn } from "~/lib/utils";

// Scale once from double size so miniature gaps and radii stay proportional.
// Use transforms and opacity for movement, and stop animation while idle.

const W = 224;
const H = 128;
const GAP = 8;
const SIDEBAR = 56;
const SIDE_PANE = 60;
const PANE_TOP = GAP;
const PANE_HEIGHT = H - GAP * 2;
// The chat pane's edges, open (beside both panels) and closed (alone).
const OPEN_LEFT = SIDEBAR;
const OPEN_RIGHT = W - GAP - SIDE_PANE - GAP;
const CLOSED_LEFT = GAP;
const CLOSED_RIGHT = W - GAP;
// The rounded ends stay unscaled and move with each edge; only the straight
// middle stretches.
const CAP = 16;

const MOVE =
  "transition-[transform,opacity] duration-(--preview-duration) ease-out motion-reduce:transition-none";

// The caps overlap the middle, so each part is opaque underneath its tint
// and the overlap never doubles up.
const COMPOSER_CLASS =
  "overflow-hidden border-y border-foreground/8 bg-background before:absolute before:inset-0 before:bg-foreground/4";

const SIDEBAR_ROW_WIDTHS = ["w-4/5", "w-3/5", "w-[70%]", "w-1/2"] as const;

/**
 * A horizontal bar whose two ends follow the chat pane's edges: the caps
 * translate, the middle scales between them. `inset` is the bar's distance
 * from each pane edge.
 */
function StretchBar({
  open,
  inset,
  top,
  height,
  capClassName,
  middleClassName,
  leftCapClassName,
  rightCapClassName,
  children,
}: {
  open: boolean;
  inset: number;
  top: number;
  height: number;
  capClassName: string;
  middleClassName: string;
  leftCapClassName: string;
  rightCapClassName: string;
  children?: ReactNode;
}) {
  const closedLeft = CLOSED_LEFT + inset;
  const closedRight = CLOSED_RIGHT - inset;
  const openLeft = OPEN_LEFT + inset;
  const openRight = OPEN_RIGHT - inset;
  const leftShift = open ? openLeft - closedLeft : 0;
  const rightShift = open ? openRight - closedRight : 0;
  const closedMiddle = closedRight - closedLeft - CAP;
  const openMiddle = openRight - openLeft - CAP;
  const middleStyle: CSSProperties = {
    left: closedLeft + CAP / 2,
    top,
    width: closedMiddle,
    height,
    transform: `translateX(${leftShift}px) scaleX(${open ? openMiddle / closedMiddle : 1})`,
  };
  return (
    <>
      <span className={cn("absolute origin-left", MOVE, middleClassName)} style={middleStyle} />
      <span
        className={cn("absolute", MOVE, capClassName, leftCapClassName)}
        style={{
          left: closedLeft,
          top,
          width: CAP,
          height,
          transform: `translateX(${leftShift}px)`,
        }}
      />
      <span
        className={cn(
          "absolute flex items-center justify-end",
          MOVE,
          capClassName,
          rightCapClassName,
        )}
        style={{
          left: closedRight - CAP,
          top,
          width: CAP,
          height,
          transform: `translateX(${rightShift}px)`,
        }}
      >
        {children}
      </span>
    </>
  );
}

export function PanelAnimationsPreview({ durationMs }: { durationMs: number }) {
  const [panelsOpen, setPanelsOpen] = useState(true);
  const leftShift = panelsOpen ? OPEN_LEFT - CLOSED_LEFT : 0;
  const rightShift = panelsOpen ? OPEN_RIGHT - CLOSED_RIGHT : 0;

  return (
    <button
      type="button"
      aria-label="Replay panel animation preview"
      className="relative h-16 w-28 shrink-0 cursor-pointer overflow-hidden rounded-control outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      onClick={() => setPanelsOpen((open) => !open)}
      style={{ "--preview-duration": `${durationMs}ms` } as CSSProperties}
    >
      {/* The chrome takes black chrome's tokens; the panes keep the page's. */}
      <span
        aria-hidden
        data-chrome-scope=""
        className="absolute inset-0 bg-(--app-chrome-background)"
      />
      <span
        aria-hidden
        className="absolute top-0 left-0 origin-top-left scale-50"
        style={{ width: W, height: H }}
      >
        {/* The sidebar, on the chrome. */}
        <span
          data-chrome-scope=""
          className={cn(
            "absolute inset-y-0 left-0 flex flex-col gap-2.5 px-3 pt-3 pb-3.5",
            MOVE,
            panelsOpen ? "opacity-100" : "-translate-x-full opacity-0",
          )}
          style={{ width: SIDEBAR - GAP }}
        >
          <span className="flex gap-1.5">
            <span className="size-2 rounded-full bg-foreground/25" />
            <span className="size-2 rounded-full bg-foreground/25" />
            <span className="size-2 rounded-full bg-foreground/25" />
          </span>
          <span className="h-4 rounded-full bg-foreground/12" />
          {SIDEBAR_ROW_WIDTHS.map((width) => (
            <span className={cn("h-1 rounded-full bg-foreground/20", width)} key={width} />
          ))}
          <span className="mt-auto h-4 rounded-sm bg-foreground/10" />
        </span>

        {/* The chat pane: the surface and the composer stretch, the rest
            rides its edges. */}
        <StretchBar
          open={panelsOpen}
          inset={0}
          top={PANE_TOP}
          height={PANE_HEIGHT}
          capClassName="bg-background"
          middleClassName="bg-background"
          leftCapClassName="rounded-bl-item"
          rightCapClassName="rounded-r-item"
        />
        <span
          className={cn("absolute flex flex-col items-start", MOVE)}
          style={{
            left: CLOSED_LEFT,
            top: PANE_TOP,
            transform: `translateX(${leftShift}px)`,
          }}
        >
          <PaneNotchTab className="h-4 w-12 gap-1.5 px-2">
            <span className="size-1.5 shrink-0 rounded-full bg-foreground/40" />
            <span className="h-1 flex-1 rounded-full bg-foreground/35" />
          </PaneNotchTab>
          <span className="mt-9 ms-3 flex flex-col gap-2">
            <span className="h-1 w-14 rounded-full bg-foreground/14" />
            <span className="h-1 w-11 rounded-full bg-foreground/11" />
            <span className="h-1 w-12 rounded-full bg-foreground/11" />
          </span>
        </span>
        <span
          className={cn("absolute h-5 w-10 rounded-md bg-foreground/8", MOVE)}
          style={{
            left: CLOSED_RIGHT - 8 - 40,
            top: PANE_TOP + 24,
            transform: `translateX(${rightShift}px)`,
          }}
        />
        <StretchBar
          open={panelsOpen}
          inset={8}
          top={PANE_TOP + PANE_HEIGHT - 8 - 20}
          height={20}
          capClassName={COMPOSER_CLASS}
          middleClassName={COMPOSER_CLASS}
          leftCapClassName="rounded-l-item border-l"
          rightCapClassName="rounded-r-item border-r pe-1"
        >
          <span className="size-2.5 shrink-0 rounded-full bg-foreground/60" />
        </StretchBar>

        {/* The side pane, beside the chat. */}
        <span
          className={cn(
            "absolute flex flex-col overflow-hidden rounded-item rounded-tl-none bg-background",
            MOVE,
            panelsOpen ? "opacity-100" : "opacity-0",
          )}
          style={{
            left: W - GAP - SIDE_PANE,
            top: PANE_TOP,
            width: SIDE_PANE,
            height: PANE_HEIGHT,
            transform: panelsOpen ? undefined : `translateX(${SIDE_PANE + GAP}px)`,
          }}
        >
          <PaneNotchTab className="h-4 w-10 shrink-0 gap-1.5 px-2">
            <span className="size-1.5 shrink-0 rounded-full bg-foreground/40" />
            <span className="h-1 flex-1 rounded-full bg-foreground/35" />
          </PaneNotchTab>
          <LayoutPaneSkeleton shape="diff" />
        </span>
      </span>
    </button>
  );
}
