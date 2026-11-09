import { AppWindowIcon, AtSignIcon, Columns2Icon, Layers2Icon, Rows2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { PANE_TAB_CLASS } from "../components/PaneNotch";
import { useScrollingWorkspacesEnabled } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import {
  LAYOUT_DROP_CHROME_HEIGHT,
  layoutDropLabel,
  useLayoutDragState,
  type LayoutDragPane,
  type LayoutDragRect,
  type LayoutDragState,
  type LayoutDropTarget,
} from "./layoutDrag";
import { findLayoutTab, type LayoutTab } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { useLayoutTabLabel } from "./PaneTabs";

/** Pen C4fxiA: drop zones sit 8px inside the pane, 7.5px each side of its middle. */
const ZONE_INSET = 8;
/** Pen gd0p3/DtAyy: edge grips are 40x4, just inside each side of a pane. */
const GRIP_LENGTH = 40;
const GRIP_THICKNESS = 4;
/** Pen ZyA9S/JYBD5: window-edge bars are 6px, 4px outside the strip. */
const EXTEND_THICKNESS = 6;
const EXTEND_GAP = 4;
/** The dragged row covers the composer, so the mention pill's middle sits this far above it. */
const MENTION_PILL_LIFT = 24;

type Box = { left: number; top: number; width: number; height: number };

function box(rect: LayoutDragRect): Box {
  return {
    left: rect.left,
    top: rect.top,
    width: Math.max(0, rect.right - rect.left),
    height: Math.max(0, rect.bottom - rect.top),
  };
}

/** The part of the window a drop fills, previewed as the highlighted zone. */
function targetZone(state: LayoutDragState, target: LayoutDropTarget): Box | null {
  const { strip } = state;
  if (target.kind === "extend") {
    const width = strip.right - strip.left;
    const height = strip.bottom - strip.top;
    if (target.edge === "left") {
      return box({ ...strip, right: strip.left + width / 3 });
    }
    if (target.edge === "right") {
      return box({ ...strip, left: strip.right - width / 3 });
    }
    return box({ ...strip, top: strip.bottom - height / 3 });
  }
  const pane = state.panes.find((candidate) => candidate.paneId === target.paneId);
  if (!pane) return null;
  const { rect } = pane;
  if (target.kind === "into") {
    return box({
      left: rect.left + ZONE_INSET / 2,
      top: rect.top + ZONE_INSET / 2,
      right: rect.right - ZONE_INSET / 2,
      bottom: rect.top + LAYOUT_DROP_CHROME_HEIGHT - ZONE_INSET / 2,
    });
  }
  const body = {
    left: rect.left + ZONE_INSET,
    top: rect.top + LAYOUT_DROP_CHROME_HEIGHT,
    right: rect.right - ZONE_INSET,
    bottom: rect.bottom - ZONE_INSET,
  };
  const midX = (rect.left + rect.right) / 2;
  const midY = (body.top + body.bottom) / 2;
  const half = ZONE_INSET - 0.5;
  switch (target.side) {
    case "left":
      return box({ ...body, right: midX - half });
    case "right":
      return box({ ...body, left: midX + half });
    case "up":
      return box({ ...body, bottom: midY - half });
    case "down":
      return box({ ...body, top: midY + half });
  }
}

function PillIcon({ target }: { target: LayoutDropTarget }) {
  const className = "size-3.25 shrink-0";
  if (target.kind === "into") return <AppWindowIcon aria-hidden className={className} />;
  if (target.kind === "extend" && target.edge === "bottom") {
    return <Layers2Icon aria-hidden className={className} />;
  }
  if (target.kind === "side" && (target.side === "up" || target.side === "down")) {
    return <Rows2Icon aria-hidden className={className} />;
  }
  return <Columns2Icon aria-hidden className={className} />;
}

function PaneGrips({ pane, target }: { pane: LayoutDragPane; target: LayoutDropTarget | null }) {
  const { rect } = pane;
  const active = target?.kind === "side" && target.paneId === pane.paneId ? target.side : null;
  const bodyTop = rect.top + LAYOUT_DROP_CHROME_HEIGHT;
  const midX = (rect.left + rect.right) / 2;
  const midY = (bodyTop + rect.bottom) / 2;
  const grips = [
    {
      side: "up",
      left: midX - GRIP_LENGTH / 2,
      top: bodyTop - GRIP_THICKNESS / 2,
      width: GRIP_LENGTH,
      height: GRIP_THICKNESS,
    },
    {
      side: "down",
      left: midX - GRIP_LENGTH / 2,
      top: rect.bottom - ZONE_INSET - GRIP_THICKNESS / 2,
      width: GRIP_LENGTH,
      height: GRIP_THICKNESS,
    },
    {
      side: "left",
      left: rect.left + ZONE_INSET - GRIP_THICKNESS / 2,
      top: midY - GRIP_LENGTH / 2,
      width: GRIP_THICKNESS,
      height: GRIP_LENGTH,
    },
    {
      side: "right",
      left: rect.right - ZONE_INSET - GRIP_THICKNESS / 2,
      top: midY - GRIP_LENGTH / 2,
      width: GRIP_THICKNESS,
      height: GRIP_LENGTH,
    },
  ] as const;
  return grips.map((grip) => (
    <div
      key={grip.side}
      className={cn(
        "absolute rounded-full",
        grip.side === active ? "bg-strong-foreground" : "bg-foreground/35",
      )}
      style={{ left: grip.left, top: grip.top, width: grip.width, height: grip.height }}
    />
  ));
}

function ExtendBars({ state }: { state: LayoutDragState }) {
  const scrollingWorkspaces = useScrollingWorkspacesEnabled();
  const { strip, target } = state;
  const active = target?.kind === "extend" ? target.edge : null;
  const maxX = window.innerWidth - EXTEND_THICKNESS;
  const maxY = window.innerHeight - EXTEND_THICKNESS;
  const bars = [
    {
      edge: "left",
      left: Math.max(0, strip.left - EXTEND_GAP - EXTEND_THICKNESS),
      top: strip.top + ZONE_INSET,
      width: EXTEND_THICKNESS,
      height: strip.bottom - strip.top - ZONE_INSET * 2,
    },
    {
      edge: "right",
      left: Math.min(maxX, strip.right + EXTEND_GAP),
      top: strip.top + ZONE_INSET,
      width: EXTEND_THICKNESS,
      height: strip.bottom - strip.top - ZONE_INSET * 2,
    },
    {
      edge: "bottom",
      left: strip.left + ZONE_INSET,
      top: Math.min(maxY, strip.bottom + EXTEND_GAP - 1),
      width: strip.right - strip.left - ZONE_INSET * 2,
      height: EXTEND_THICKNESS,
    },
  ] as const;
  return bars
    .filter((bar) => bar.edge !== "bottom" || scrollingWorkspaces)
    .map((bar) => (
      <div
        key={bar.edge}
        className={cn(
          "absolute rounded-model-tag inset-ring",
          bar.edge === active
            ? "bg-foreground/35 inset-ring-foreground/50"
            : "bg-foreground/12 inset-ring-foreground/20",
        )}
        style={{ left: bar.left, top: bar.top, width: bar.width, height: bar.height }}
      />
    ));
}

/** The lifted, tilted tab under the pointer (pen G1JJK). */
function DraggedTabGhost({ tabId, point }: { tabId: string; point: { x: number; y: number } }) {
  const tab = useLayoutStore(
    (state) => findLayoutTab(state.layout, (candidate) => candidate.id === tabId)?.tab ?? null,
  );
  if (!tab) return null;
  return <DraggedTabGhostBody tab={tab} point={point} />;
}

function DraggedTabGhostBody({ tab, point }: { tab: LayoutTab; point: { x: number; y: number } }) {
  const label = useLayoutTabLabel(tab);
  return (
    <div
      className={cn(PANE_TAB_CLASS, "absolute left-0 top-0 surface-popover")}
      style={{ transform: `translate(${point.x - 24}px, ${point.y - 14}px) rotate(-2deg)` }}
    >
      {label.icon}
      <span className="min-w-0 truncate">{label.title}</span>
    </div>
  );
}

/** Cuts the composers out of the zones, so a composer reads as above them. */
function zonesClipPath(composers: readonly LayoutDragRect[]): string | undefined {
  if (composers.length === 0) return undefined;
  const holes = composers.map(
    (rect) => `M${rect.left} ${rect.top}H${rect.right}V${rect.bottom}H${rect.left}Z`,
  );
  return `path(evenodd, "M0 0H${window.innerWidth}V${window.innerHeight}H0Z${holes.join("")}")`;
}

/** The label that names where the drop lands (pen MI18S). */
function DropPill({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div
      className="absolute flex h-6.5 -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-control bg-strong-foreground px-2.5 text-meta whitespace-nowrap text-background shadow-drag-label"
      style={{ left: x, top: y }}
    >
      {children}
    </div>
  );
}

/** A window overlay keeps webviews and iframes from swallowing layout drags. */
export function LayoutDropZones() {
  const state = useLayoutDragState();
  if (!state) return null;
  const zone = state.target ? targetZone(state, state.target) : null;
  return createPortal(
    <div
      data-layout-drag-overlay=""
      aria-hidden
      className="fixed inset-0 z-[90] cursor-grabbing select-none"
    >
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0" style={{ clipPath: zonesClipPath(state.composers) }}>
          <ExtendBars state={state} />
          {zone ? (
            <div
              className="absolute rounded-card bg-foreground/[0.04] inset-ring inset-ring-foreground/22"
              style={zone}
            />
          ) : null}
          {state.panes.map((pane) => (
            <PaneGrips key={pane.paneId} pane={pane} target={state.target} />
          ))}
        </div>
        {state.source.kind === "tab" ? (
          <DraggedTabGhost tabId={state.source.tabId} point={state.point} />
        ) : null}
        {zone && state.target ? (
          <DropPill x={zone.left + zone.width / 2} y={zone.top + zone.height / 2}>
            <PillIcon target={state.target} />
            {layoutDropLabel(state.target)}
          </DropPill>
        ) : null}
        {state.composer ? (
          <DropPill
            x={(state.composer.left + state.composer.right) / 2}
            y={state.composer.top - MENTION_PILL_LIFT}
          >
            <AtSignIcon aria-hidden className="size-3.25 shrink-0" />
            Mention thread
          </DropPill>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
