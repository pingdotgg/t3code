/**
 * Keep drag previews local and commit once on release.
 * Reuse live-layout drop targets and snapping so the template follows the same rules.
 */
import type { LayoutPaneKind, LayoutTemplate, LayoutWhenNoRoom } from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  Columns2Icon,
  FileDiffIcon,
  FilesIcon,
  GlobeIcon,
  MessageSquareIcon,
  Rows2Icon,
  SquareTerminalIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { snapToPreset } from "../../layout/ColumnResizeHandle";
import { resolveLayoutDropTarget, type LayoutDropTarget } from "../../layout/layoutDrag";
import {
  LayoutPaneSkeleton,
  PaneNotchTab,
  type LayoutPaneSkeletonShape,
} from "../../layout/PaneSkeleton";
import {
  LAYOUT_TEMPLATE_BOTTOM_SHARE,
  LAYOUT_TEMPLATE_SPLIT_SHARE,
  canLayoutTemplatePaneSpan,
  countLayoutTemplatePanes,
  extendLayoutTemplate,
  isOnlyLayoutTemplateChat,
  layoutTemplatePaneMeasure,
  removeLayoutTemplatePane,
  resizeLayoutTemplateColumnDivider,
  resizeLayoutTemplatePaneDivider,
  setLayoutTemplatePaneKind,
  setLayoutTemplatePaneShare,
  setLayoutTemplatePaneSpan,
  splitLayoutTemplatePane,
  type LayoutTemplatePath,
} from "../../layout/layoutTemplate";
import { cn, isMacPlatform } from "../../lib/utils";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ContentButton } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsGroup } from "./SettingsGroup";

const PANE_KINDS: ReadonlyArray<{
  kind: LayoutPaneKind;
  label: string;
  icon: LucideIcon;
  shape: LayoutPaneSkeletonShape;
}> = [
  { kind: "chat", label: "Chat", icon: MessageSquareIcon, shape: "chat" },
  { kind: "terminal", label: "Terminal", icon: SquareTerminalIcon, shape: "terminal" },
  { kind: "diff", label: "Diff", icon: FileDiffIcon, shape: "diff" },
  { kind: "files", label: "Files", icon: FilesIcon, shape: "lines" },
  { kind: "browser", label: "Browser", icon: GlobeIcon, shape: "lines" },
];

function paneKindMeta(kind: LayoutPaneKind) {
  return PANE_KINDS.find((entry) => entry.kind === kind) ?? PANE_KINDS[0]!;
}

/** Pen: 10px canvas padding, 6px between panes. */
const CANVAS_PADDING_PX = 10;
const PANE_GAP_PX = 6;
/** Pointer travel before a press on a chip becomes a drag, so a click still adds. */
const DRAG_THRESHOLD_PX = 6;
/** Keyboard step for a focused divider. */
const DIVIDER_KEY_STEP = 0.05;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PaneSlot {
  id: string;
  path: LayoutTemplatePath;
  kind: LayoutPaneKind;
  /** Fractions of the canvas's inner box. */
  rect: Rect;
  /** What the % badge shows: the pane's height in its column, else its column's width. */
  badge: number | null;
}

type DividerSlot =
  | {
      kind: "pane";
      id: string;
      column: number;
      index: number;
      /** The pair of panes the divider sits between, as fractions of the canvas. */
      pair: Rect;
      share: number;
    }
  | { kind: "column"; id: string; index: number; pair: Rect; share: number };

function paneId(path: LayoutTemplatePath): string {
  return `${path.column}:${path.pane}`;
}

/**
 * Where each pane sits. Columns share the width; a full-width bottom pane
 * (the first column's last, `span: "full"`) runs under every column, and
 * the other columns fill the height above it.
 */
function layoutTemplateSlots(template: LayoutTemplate): {
  panes: PaneSlot[];
  dividers: DividerSlot[];
} {
  const columns = template.columns;
  const first = columns[0];
  const fullPane =
    first && columns.length > 1 && first.panes.at(-1)?.span === "full" && first.panes.length > 1
      ? first.panes.at(-1)!
      : null;
  const fullHeight = fullPane?.size ?? 0;
  const topHeight = 1 - fullHeight;
  const panes: PaneSlot[] = [];
  const dividers: DividerSlot[] = [];
  let left = 0;
  columns.forEach((column, columnIndex) => {
    const isFirst = columnIndex === 0;
    let top = 0;
    const rects = column.panes.map((pane, paneIndex) => {
      const isFull = isFirst && fullPane !== null && paneIndex === column.panes.length - 1;
      if (isFull) {
        return { left: 0, top: topHeight, width: 1, height: fullHeight };
      }
      // First-column panes keep their share of the whole height; other
      // columns divide the height above the full-width pane.
      const height = isFirst ? pane.size : pane.size * topHeight;
      const rect = { left, top, width: column.size, height };
      top += height;
      return rect;
    });
    column.panes.forEach((pane, paneIndex) => {
      const path = { column: columnIndex, pane: paneIndex };
      panes.push({
        id: paneId(path),
        path,
        kind: pane.kind,
        rect: rects[paneIndex]!,
        badge: column.panes.length > 1 ? pane.size : columns.length > 1 ? column.size : null,
      });
      const next = rects[paneIndex + 1];
      if (next) {
        const current = rects[paneIndex]!;
        const pairTop = current.top;
        const pairBottom = next.top + next.height;
        const pairLeft = Math.min(current.left, next.left);
        const pairRight = Math.max(current.left + current.width, next.left + next.width);
        dividers.push({
          kind: "pane",
          id: `pane:${columnIndex}:${paneIndex}`,
          column: columnIndex,
          index: paneIndex,
          pair: {
            left: pairLeft,
            top: pairTop,
            width: pairRight - pairLeft,
            height: pairBottom - pairTop,
          },
          share: pane.size / (pane.size + column.panes[paneIndex + 1]!.size),
        });
      }
    });
    const nextColumn = columns[columnIndex + 1];
    if (nextColumn) {
      dividers.push({
        kind: "column",
        id: `column:${columnIndex}`,
        index: columnIndex,
        pair: { left, top: 0, width: column.size + nextColumn.size, height: topHeight },
        share: column.size / (column.size + nextColumn.size),
      });
    }
    left += column.size;
  });
  return { panes, dividers };
}

/** CSS box for a fraction rect inside the padded canvas, with the pen's gap between neighbors. */
function slotStyle(rect: Rect): CSSProperties {
  // Half the gap on every edge that has a neighbor, none on the canvas edges.
  const half = PANE_GAP_PX / 2;
  const startX = rect.left <= 1e-6 ? 0 : half;
  const endX = rect.left + rect.width >= 1 - 1e-6 ? 0 : half;
  const startY = rect.top <= 1e-6 ? 0 : half;
  const endY = rect.top + rect.height >= 1 - 1e-6 ? 0 : half;
  return {
    left: `calc(${rect.left * 100}% + ${startX}px)`,
    top: `calc(${rect.top * 100}% + ${startY}px)`,
    width: `calc(${rect.width * 100}% - ${startX + endX}px)`,
    height: `calc(${rect.height * 100}% - ${startY + endY}px)`,
  };
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function dropLabel(target: LayoutDropTarget): string {
  if (target.kind === "extend") {
    return target.edge === "bottom"
      ? `Full width · ${percent(LAYOUT_TEMPLATE_BOTTOM_SHARE)}`
      : `New column · ${percent(LAYOUT_TEMPLATE_SPLIT_SHARE)}`;
  }
  if (target.kind !== "side") return "";
  const side = { left: "left", right: "right", up: "up", down: "down" }[target.side];
  return `Split ${side} · ${percent(LAYOUT_TEMPLATE_SPLIT_SHARE)}`;
}

function applyDrop(
  template: LayoutTemplate,
  target: LayoutDropTarget,
  kind: LayoutPaneKind,
  slots: readonly PaneSlot[],
): LayoutTemplate {
  if (target.kind === "extend") return extendLayoutTemplate(template, target.edge, kind);
  if (target.kind !== "side") return template;
  const slot = slots.find((candidate) => candidate.id === target.paneId);
  return slot ? splitLayoutTemplatePane(template, slot.path, target.side, kind) : template;
}

/** The part of a pane a side drop takes, as a fraction rect. */
function dropZoneRect(slot: PaneSlot, side: "left" | "right" | "up" | "down"): Rect {
  const share = LAYOUT_TEMPLATE_SPLIT_SHARE;
  const { left, top, width, height } = slot.rect;
  switch (side) {
    case "left":
      return { left, top, width: width * share, height };
    case "right":
      return { left: left + width * (1 - share), top, width: width * share, height };
    case "up":
      return { left, top, width, height: height * share };
    case "down":
      return { left, top: top + height * (1 - share), width, height: height * share };
  }
}

interface ChipDrag {
  kind: LayoutPaneKind;
  point: { x: number; y: number };
  target: LayoutDropTarget | null;
}

type DividerDrag = { id: string; template: LayoutTemplate; share: number };

export function LayoutEditor({
  template,
  onChange,
  stripPreview = null,
}: {
  template: LayoutTemplate;
  /** One call per finished edit: a drop, a divider release, a popover change. */
  onChange: (next: LayoutTemplate) => void;
  /** While set, the canvas shows how the strip runs past its edges (pen Nm9FG). */
  stripPreview?: LayoutWhenNoRoom | null;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [chipDrag, setChipDrag] = useState<ChipDrag | null>(null);
  const [dividerDrag, setDividerDrag] = useState<DividerDrag | null>(null);
  const [openPaneId, setOpenPaneId] = useState<string | null>(null);
  // A divider drag previews its own template; everything else shows the saved one.
  const shown = dividerDrag?.template ?? template;
  const { panes, dividers } = layoutTemplateSlots(shown);

  const innerRect = (): DOMRect | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return new DOMRect(
      rect.left + CANVAS_PADDING_PX,
      rect.top + CANVAS_PADDING_PX,
      rect.width - CANVAS_PADDING_PX * 2,
      rect.height - CANVAS_PADDING_PX * 2,
    );
  };

  const resolveTarget = (point: { x: number; y: number }): LayoutDropTarget | null => {
    const inner = innerRect();
    if (!inner) return null;
    const toPx = (rect: Rect) => ({
      left: inner.left + rect.left * inner.width,
      top: inner.top + rect.top * inner.height,
      right: inner.left + (rect.left + rect.width) * inner.width,
      bottom: inner.top + (rect.top + rect.height) * inner.height,
    });
    return resolveLayoutDropTarget(
      point,
      // Template panes hold one kind each, so there is no "add as tab":
      // mark them companions and give them no chrome row.
      panes.map((slot) => ({ paneId: slot.id, rect: toPx(slot.rect), companion: true })),
      { left: inner.left, top: inner.top, right: inner.right, bottom: inner.bottom },
      0,
    );
  };

  // Chip drags: window listeners while the pointer is down on a chip.
  const chipPress = useRef<{ kind: LayoutPaneKind; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own Escape and pointer capture cleanup only while a template chip is being dragged.
  useEffect(() => {
    if (chipDrag === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      chipPress.current = null;
      // The release still clicks the chip; that click must not add a pane.
      suppressClick.current = true;
      setChipDrag(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [chipDrag]);

  const onChipPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, kind: LayoutPaneKind) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    chipPress.current = { kind, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onChipPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const press = chipPress.current;
    if (!press) return;
    const point = { x: event.clientX, y: event.clientY };
    if (chipDrag === null && Math.hypot(point.x - press.x, point.y - press.y) < DRAG_THRESHOLD_PX) {
      return;
    }
    setChipDrag({ kind: press.kind, point, target: resolveTarget(point) });
  };
  const onChipPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = chipDrag;
    chipPress.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag === null) return;
    suppressClick.current = true;
    setChipDrag(null);
    if (drag.target) {
      const next = applyDrop(template, drag.target, drag.kind, panes);
      if (next !== template) onChange(next);
    }
  };
  const onChipPointerCancel = () => {
    chipPress.current = null;
    setChipDrag(null);
  };
  const onChipClick = (kind: LayoutPaneKind) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    // Without a drag (keyboard, or a plain click) the pane joins on the right.
    const next = extendLayoutTemplate(template, "right", kind);
    if (next !== template) onChange(next);
  };

  // Divider drags.
  const dividerPress = useRef<DividerSlot | null>(null);
  const shareFromPointer = (divider: DividerSlot, point: { x: number; y: number }) => {
    const inner = innerRect();
    if (!inner) return null;
    const extent =
      divider.kind === "pane"
        ? divider.pair.height * inner.height
        : divider.pair.width * inner.width;
    const raw =
      divider.kind === "pane"
        ? (point.y - (inner.top + divider.pair.top * inner.height)) / extent
        : (point.x - (inner.left + divider.pair.left * inner.width)) / extent;
    return snapToPreset(Math.max(0, Math.min(1, raw)), extent).value;
  };
  const resizeTo = (base: LayoutTemplate, divider: DividerSlot, share: number) =>
    divider.kind === "pane"
      ? resizeLayoutTemplatePaneDivider(base, divider.column, divider.index, share)
      : resizeLayoutTemplateColumnDivider(base, divider.index, share);

  const onDividerPointerDown = (event: ReactPointerEvent<HTMLDivElement>, divider: DividerSlot) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dividerPress.current = divider;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDividerDrag({ id: divider.id, template, share: divider.share });
  };
  const onDividerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const divider = dividerPress.current;
    if (!divider) return;
    const share = shareFromPointer(divider, { x: event.clientX, y: event.clientY });
    if (share === null) return;
    const next = resizeTo(template, divider, share);
    const actual =
      layoutTemplateSlots(next).dividers.find((entry) => entry.id === divider.id)?.share ?? share;
    setDividerDrag({ id: divider.id, template: next, share: actual });
  };
  const onDividerPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    dividerPress.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const drag = dividerDrag;
    setDividerDrag(null);
    if (drag && drag.template !== template) onChange(drag.template);
  };
  const onDividerKeyDown = (event: KeyboardEvent<HTMLDivElement>, divider: DividerSlot) => {
    const back = divider.kind === "pane" ? "ArrowUp" : "ArrowLeft";
    const forward = divider.kind === "pane" ? "ArrowDown" : "ArrowRight";
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    const step = event.key === forward ? DIVIDER_KEY_STEP : -DIVIDER_KEY_STEP;
    const next = resizeTo(template, divider, divider.share + step);
    if (next !== template) onChange(next);
  };

  const zone = (() => {
    const target = chipDrag?.target;
    if (!target) return null;
    if (target.kind === "side") {
      const slot = panes.find((candidate) => candidate.id === target.paneId);
      return slot ? dropZoneRect(slot, target.side) : null;
    }
    if (target.kind !== "extend") return null;
    if (target.edge === "bottom") {
      return {
        left: 0,
        top: 1 - LAYOUT_TEMPLATE_BOTTOM_SHARE,
        width: 1,
        height: LAYOUT_TEMPLATE_BOTTOM_SHARE,
      };
    }
    const width = LAYOUT_TEMPLATE_SPLIT_SHARE;
    return { left: target.edge === "left" ? 0 : 1 - width, top: 0, width, height: 1 };
  })();
  const activeDivider = dividerDrag
    ? (dividers.find((divider) => divider.id === dividerDrag.id) ?? null)
    : null;
  const onlyPane = countLayoutTemplatePanes(template) <= 1;

  return (
    <SettingsGroup divided={false} className="flex flex-col gap-3 px-4 py-3">
      <div
        ref={canvasRef}
        className="relative h-[262px] overflow-hidden rounded-lg border border-border bg-(--app-chrome-background) select-none"
        style={{ padding: CANVAS_PADDING_PX }}
      >
        {stripPreview ? (
          <StripPreview whenNoRoom={stripPreview} />
        ) : (
          <div className="relative size-full">
            {panes.map((slot) => (
              <TemplatePane
                key={slot.id}
                slot={slot}
                template={template}
                open={openPaneId === slot.id}
                onOpenChange={(open) => setOpenPaneId(open ? slot.id : null)}
                onChange={(next) => {
                  if (next !== template) onChange(next);
                }}
                onlyPane={onlyPane}
              />
            ))}
            {dividers.map((divider) => (
              <TemplateDivider
                key={divider.id}
                divider={divider}
                active={dividerDrag?.id === divider.id}
                onPointerDown={(event) => onDividerPointerDown(event, divider)}
                onPointerMove={onDividerPointerMove}
                onPointerUp={onDividerPointerUp}
                onKeyDown={(event) => onDividerKeyDown(event, divider)}
              />
            ))}
            {chipDrag ? <DropFeedback panes={panes} target={chipDrag.target} zone={zone} /> : null}
            {activeDivider && dividerDrag ? (
              <DividerReadout divider={activeDivider} share={dividerDrag.share} />
            ) : null}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Text variant="meta" tone="dim" render={<h3 />}>
          Drag in
        </Text>
        {PANE_KINDS.map(({ kind, label, icon: Icon }) => (
          <Tooltip key={kind}>
            <TooltipTrigger
              render={
                <ContentButton
                  variant="drag-chip"
                  type="button"
                  onPointerDown={(event) => onChipPointerDown(event, kind)}
                  onPointerMove={onChipPointerMove}
                  onPointerUp={onChipPointerUp}
                  onPointerCancel={onChipPointerCancel}
                  onClick={() => onChipClick(kind)}
                />
              }
            >
              <Icon aria-hidden className="size-3 text-muted-foreground" />
              {label}
            </TooltipTrigger>
            <TooltipPopup side="top">
              Drag onto the layout, or click to add it on the right
            </TooltipPopup>
          </Tooltip>
        ))}
        <span className="ms-auto text-caption text-dim-foreground">
          {chipDrag
            ? "Edges extend"
            : stripPreview === "always-shrink"
              ? "Columns share the window"
              : stripPreview
                ? "Columns keep their width"
                : "Drag dividers to resize"}
        </span>
      </div>
      {chipDrag
        ? createPortal(
            <div
              aria-hidden
              className="pointer-events-none fixed z-[140] -rotate-2"
              style={{ left: chipDrag.point.x + 8, top: chipDrag.point.y + 8 }}
            >
              <ChipGhost kind={chipDrag.kind} />
            </div>,
            document.body,
          )
        : null}
    </SettingsGroup>
  );
}

/**
 * The strip past the canvas's edges (pen Nm9FG): new tabs continue to the
 * right at a readable width and the next workspace waits below. With
 * "Always shrink" the columns squeeze into the window instead.
 */
function StripPreview({ whenNoRoom }: { whenNoRoom: LayoutWhenNoRoom }) {
  const shrink = whenNoRoom === "always-shrink";
  const width = shrink ? 1 / 3 : 0.46;
  const top = 0.74;
  const columns: ReadonlyArray<{ label: string; badge: boolean }> = [
    { label: "Chat", badge: true },
    { label: "New tab", badge: true },
    { label: "Next tab", badge: shrink },
  ];
  return (
    <div data-layout-strip-preview={whenNoRoom} className="relative size-full">
      {columns.map((column, index) => (
        <PreviewPane
          key={column.label}
          label={column.label}
          icon={MessageSquareIcon}
          shape="chat"
          badge={column.badge ? width : null}
          rect={{ left: index * width, top: 0, width, height: top }}
        />
      ))}
      <PreviewPane
        label="Research"
        icon={SquareTerminalIcon}
        shape="terminal"
        badge={null}
        rect={{ left: 0, top, width: 0.5, height: 0.6 }}
      />
      {shrink ? null : (
        <PreviewPill
          icon={ArrowRightIcon}
          className="-translate-y-1/2"
          style={{ right: 8, top: "38%" }}
        >
          New tabs continue here
        </PreviewPill>
      )}
      <PreviewPill
        icon={ArrowDownIcon}
        className="-translate-x-1/2 -translate-y-1/2"
        style={{ left: "50%", top: `${top * 100}%` }}
      >
        Next workspace below
      </PreviewPill>
    </div>
  );
}

function PreviewPane({
  label,
  icon: Icon,
  shape,
  badge,
  rect,
}: {
  label: string;
  icon: LucideIcon;
  shape: LayoutPaneSkeletonShape;
  badge: number | null;
  rect: Rect;
}) {
  return (
    <div
      className="absolute flex flex-col overflow-hidden rounded-item bg-background"
      style={slotStyle(rect)}
    >
      <PaneTab icon={Icon} label={label} badge={badge} />
      <LayoutPaneSkeleton shape={shape} />
    </div>
  );
}

/** A mini pane's label in its notch tab, and its size chip. */
function PaneTab({
  icon: Icon,
  label,
  badge,
}: {
  icon: LucideIcon;
  label: string;
  badge: number | null;
}) {
  return (
    <span className="flex h-5 min-w-0 shrink-0 items-start">
      <PaneNotchTab className="h-5 gap-1.25 px-1.75 text-caption text-foreground">
        <Icon aria-hidden className="size-2.75 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{label}</span>
      </PaneNotchTab>
      {badge !== null ? (
        <span className="ms-auto mt-0.5 me-0.5 shrink-0 rounded-badge bg-foreground/8 px-1.5 text-micro leading-4.5 text-muted-foreground tabular-nums">
          {percent(badge)}
        </span>
      ) : null}
    </span>
  );
}

function PreviewPill({
  icon: Icon,
  className,
  style,
  children,
}: {
  icon: LucideIcon;
  className: string;
  style: CSSProperties;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute z-10 flex h-6 items-center gap-1.5 rounded-control bg-strong-foreground px-2 text-meta whitespace-nowrap text-background shadow-lg",
        className,
      )}
      style={style}
    >
      <Icon aria-hidden className="size-3" />
      {children}
    </span>
  );
}

function ChipGhost({ kind }: { kind: LayoutPaneKind }) {
  const { label, icon: Icon } = paneKindMeta(kind);
  return (
    <div className="flex h-6.5 items-center gap-1.5 rounded-item surface-popover px-2.25 text-meta text-foreground shadow-lg">
      <Icon aria-hidden className="size-3 text-muted-foreground" />
      {label}
    </div>
  );
}

function TemplatePane({
  slot,
  template,
  open,
  onOpenChange,
  onChange,
  onlyPane,
}: {
  slot: PaneSlot;
  template: LayoutTemplate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (next: LayoutTemplate) => void;
  onlyPane: boolean;
}) {
  const { label, icon: Icon, shape } = paneKindMeta(slot.kind);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <ContentButton
            variant="panel"
            type="button"
            aria-label={`${label} pane`}
            className="absolute"
            style={slotStyle(slot.rect)}
          />
        }
      >
        <PaneTab icon={Icon} label={label} badge={slot.badge} />
        <LayoutPaneSkeleton shape={shape} />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="sm" padding="compact">
        <PanePopoverBody
          path={slot.path}
          template={template}
          onlyPane={onlyPane}
          onChange={onChange}
          onDone={() => onOpenChange(false)}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** Pen d9oHx: kind, span, size, then split and remove. */
function PanePopoverBody({
  path,
  template,
  onlyPane,
  onChange,
  onDone,
}: {
  path: LayoutTemplatePath;
  template: LayoutTemplate;
  onlyPane: boolean;
  onChange: (next: LayoutTemplate) => void;
  onDone: () => void;
}) {
  const pane = template.columns[path.column]?.panes[path.pane];
  const measure = layoutTemplatePaneMeasure(template, path);
  const [draftShare, setDraftShare] = useState<number | null>(null);
  // The same keys that split a pane in the app (pen B4Wwa).
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  if (!pane) return null;
  const onlyChat = isOnlyLayoutTemplateChat(template, path);
  const canRemove = !onlyPane && !onlyChat;
  const share = draftShare ?? measure?.share ?? 1;
  const remove = () => {
    if (!canRemove) return;
    onChange(removeLayoutTemplatePane(template, path));
    onDone();
  };
  const splitRightKey = shortcutLabelForCommand(keybindings, "layout.splitRight");
  const splitDownKey = shortcutLabelForCommand(keybindings, "layout.splitDown");
  const split = (side: "right" | "down") => {
    onChange(splitLayoutTemplatePane(template, path, side, pane.kind, 0.5));
    onDone();
  };
  const commitShare = () => {
    if (draftShare === null) return;
    onChange(setLayoutTemplatePaneShare(template, path, draftShare));
    setDraftShare(null);
  };
  const sliderStyle = {
    "--settings-slider-progress": `${share * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - share}rem`,
  } as CSSProperties;

  return (
    <div
      className="flex flex-col gap-1"
      onKeyDown={(event) => {
        if (event.key !== "Backspace" && event.key !== "Delete") return;
        if (event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        remove();
      }}
    >
      <PopoverSection label="Pane">
        <ToggleGroup
          aria-label="Pane kind"
          variant="segmented"
          className="w-full"
          value={[pane.kind]}
          onValueChange={(value) => {
            const next = PANE_KINDS.find((entry) => entry.kind === value[0]);
            if (next) onChange(setLayoutTemplatePaneKind(template, path, next.kind));
          }}
        >
          {PANE_KINDS.map(({ kind, label, icon: Icon }) => (
            <Toggle
              key={kind}
              value={kind}
              aria-label={label}
              className="flex-1"
              disabled={onlyChat && kind !== "chat"}
            >
              <Icon aria-hidden />
            </Toggle>
          ))}
        </ToggleGroup>
      </PopoverSection>
      {canLayoutTemplatePaneSpan(template, path) ? (
        <PopoverSection label="Spans">
          <ToggleGroup
            aria-label="Pane span"
            variant="segmented"
            className="w-full"
            value={[pane.span]}
            onValueChange={(value) => {
              const span = value[0];
              if (span === "column" || span === "full") {
                onChange(setLayoutTemplatePaneSpan(template, path, span));
              }
            }}
          >
            <Toggle value="column" className="flex-1">
              Under chat
            </Toggle>
            <Toggle value="full" className="flex-1">
              Full width
            </Toggle>
          </ToggleGroup>
        </PopoverSection>
      ) : null}
      {measure ? (
        <PopoverSection label={measure.axis === "height" ? "Height" : "Width"}>
          <div className="flex items-center gap-2">
            <input
              aria-label={measure.axis === "height" ? "Pane height" : "Column width"}
              className="settings-slider min-w-0 flex-1"
              type="range"
              min={15}
              max={85}
              step={1}
              value={Math.round(share * 100)}
              style={sliderStyle}
              onChange={(event) => setDraftShare(Number(event.currentTarget.value) / 100)}
              onPointerUp={commitShare}
              onKeyUp={commitShare}
              onBlur={commitShare}
            />
            <span className="w-9 text-end text-meta text-foreground tabular-nums">
              {percent(share)}
            </span>
          </div>
        </PopoverSection>
      ) : null}
      <div className="my-1 h-px bg-divider" />
      <PopoverAction
        icon={Columns2Icon}
        label="Split right"
        {...(splitRightKey ? { shortcut: splitRightKey } : {})}
        onClick={() => split("right")}
      />
      <PopoverAction
        icon={Rows2Icon}
        label="Split down"
        {...(splitDownKey ? { shortcut: splitDownKey } : {})}
        onClick={() => split("down")}
      />
      <PopoverAction
        icon={Trash2Icon}
        label="Remove pane"
        shortcut={isMacPlatform(navigator.platform) ? "⌫" : "Backspace"}
        destructive
        disabled={!canRemove}
        onClick={remove}
      />
    </div>
  );
}

function PopoverSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 p-1.5">
      <span className="text-caption text-dim-foreground">{label}</span>
      {children}
    </div>
  );
}

function PopoverAction({
  icon: Icon,
  label,
  shortcut,
  destructive = false,
  disabled = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <ContentButton
      variant={destructive ? "action-row-destructive" : "action-row"}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full"
    >
      <Icon
        aria-hidden
        className={cn(
          "size-3.5",
          destructive ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? <span className="text-meta text-dim-foreground">{shortcut}</span> : null}
    </ContentButton>
  );
}

function TemplateDivider({
  divider,
  active,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKeyDown,
}: {
  divider: DividerSlot;
  active: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const { pair, share } = divider;
  const horizontal = divider.kind === "pane";
  // An 8px hit strip centered in the 6px gap between the pair.
  const style: CSSProperties = horizontal
    ? {
        left: `${pair.left * 100}%`,
        width: `${pair.width * 100}%`,
        top: `calc(${(pair.top + pair.height * share) * 100}% - 4px)`,
        height: 8,
      }
    : {
        top: `${pair.top * 100}%`,
        height: `${pair.height * 100}%`,
        left: `calc(${(pair.left + pair.width * share) * 100}% - 4px)`,
        width: 8,
      };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-label={horizontal ? "Resize panes" : "Resize columns"}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(share * 100)}
      className={cn(
        "group absolute z-10 flex items-center justify-center outline-none",
        horizontal ? "cursor-row-resize" : "cursor-col-resize",
      )}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <div
        className={cn(
          "rounded-full group-hover:bg-foreground/60 group-focus-visible:bg-foreground/60",
          horizontal ? "h-1 w-7" : "h-7 w-1",
          active ? "bg-foreground/80" : "bg-dim-foreground",
        )}
      />
    </div>
  );
}

/** Pen KiIZ0 "60 · 40": the pair's split while a divider drags. */
function DividerReadout({ divider, share }: { divider: DividerSlot; share: number }) {
  const first = Math.round(share * 100);
  const { pair } = divider;
  const style: CSSProperties =
    divider.kind === "pane"
      ? {
          left: `${(pair.left + pair.width / 2) * 100}%`,
          top: `${(pair.top + pair.height * share) * 100}%`,
        }
      : {
          left: `${(pair.left + pair.width * share) * 100}%`,
          top: `${(pair.top + pair.height / 2) * 100}%`,
        };
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-20 flex h-6.5 -translate-x-1/2 -translate-y-1/2 items-center rounded-control bg-strong-foreground px-2.5 text-meta text-background tabular-nums shadow-lg"
      style={style}
    >
      {first} · {100 - first}
    </div>
  );
}

/**
 * While a chip drags (pen B4Wwa): a grip on every pane side and a bar on
 * every extendable edge, the targeted one bright, the zone the pane would
 * take outlined, and a pill naming the drop.
 */
function DropFeedback({
  panes,
  target,
  zone,
}: {
  panes: readonly PaneSlot[];
  target: LayoutDropTarget | null;
  zone: Rect | null;
}) {
  const sides = ["left", "right", "up", "down"] as const;
  const gripStyle = (slot: PaneSlot, side: (typeof sides)[number]): CSSProperties => {
    const { left, top, width, height } = slot.rect;
    const centerX = `${(left + width / 2) * 100}%`;
    const centerY = `${(top + height / 2) * 100}%`;
    switch (side) {
      case "left":
        return { left: `calc(${left * 100}% + 6px)`, top: centerY, width: 4, height: 20 };
      case "right":
        return {
          left: `calc(${(left + width) * 100}% - 10px)`,
          top: centerY,
          width: 4,
          height: 20,
        };
      case "up":
        return { left: centerX, top: `calc(${top * 100}% + 22px)`, width: 20, height: 4 };
      case "down":
        return {
          left: centerX,
          top: `calc(${(top + height) * 100}% - 10px)`,
          width: 20,
          height: 4,
        };
    }
  };
  const isTarget = (slot: PaneSlot, side: (typeof sides)[number]) =>
    target?.kind === "side" && target.paneId === slot.id && target.side === side;
  const edgeActive = (edge: "left" | "right" | "bottom") =>
    target?.kind === "extend" && target.edge === edge;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20">
      {panes.flatMap((slot) =>
        sides.map((side) => (
          <div
            key={`${slot.id}:${side}`}
            className={cn(
              "absolute rounded-full",
              side === "left" || side === "right" ? "-translate-y-1/2" : "-translate-x-1/2",
              isTarget(slot, side) ? "bg-strong-foreground" : "bg-foreground/25",
            )}
            style={gripStyle(slot, side)}
          />
        )),
      )}
      <div
        className={cn(
          "absolute inset-y-0 -left-1.5 w-0.75 rounded-full",
          edgeActive("left") ? "bg-strong-foreground" : "bg-foreground/25",
        )}
      />
      <div
        className={cn(
          "absolute inset-y-0 -right-1.5 w-0.75 rounded-full",
          edgeActive("right") ? "bg-strong-foreground" : "bg-foreground/25",
        )}
      />
      <div
        className={cn(
          "absolute inset-x-0 -bottom-1.5 h-0.75 rounded-full",
          edgeActive("bottom") ? "bg-strong-foreground" : "bg-foreground/25",
        )}
      />
      {zone && target ? (
        <div
          className="absolute flex items-end justify-center rounded-item border border-strong-foreground/80 bg-strong-foreground/6 pb-2"
          style={slotStyle(zone)}
        >
          <span className="flex h-6 items-center gap-1.5 rounded-control bg-strong-foreground px-2 text-meta whitespace-nowrap text-background shadow-lg">
            {dropLabel(target)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
