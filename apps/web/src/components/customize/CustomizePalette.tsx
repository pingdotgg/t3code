import { ChevronDownIcon, ChevronUpIcon, RotateCcwIcon } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type CustomizeSurface, useCustomizeInterfaceStore } from "./customizeInterfaceStore";
import { PALETTE_MARGIN, type Point } from "./customizeLayout.logic";

/**
 * The mark every piece of the mode shares: the palette headers, the outlines
 * around the surfaces they edit, and the dock. One accent, one shape, so the
 * palettes read as parts of one tool even when they sit far apart.
 */
export function CustomizeMark({ icon, className }: { icon: ReactNode; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary ring-1 ring-primary/20 ring-inset [&_svg]:size-3.5",
        className,
      )}
    >
      {icon}
    </span>
  );
}

export function PaletteSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex min-h-5 items-center justify-between gap-2">
        <h3 className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        {action}
      </div>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      {children}
    </section>
  );
}

/** A labelled row inside a palette: label on the left, control on the right. */
export function PaletteRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <label htmlFor={htmlFor} className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{label}</span>
        {description ? (
          <span className="block text-xs text-muted-foreground">{description}</span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

export function PaletteResetButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={disabled}
            size="icon-xs"
            variant="ghost"
            onClick={onClick}
          />
        }
      >
        <RotateCcwIcon />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A floating palette. It follows the surface it edits until the user drags
 * it somewhere else, and it can fold down to its header to get out of the way.
 */
export function CustomizePalette({
  surface,
  title,
  description,
  icon,
  position,
  onMove,
  visible,
  enterDelayMs,
  headerAction,
  maxHeight,
  className,
  ref,
  children,
}: {
  surface: CustomizeSurface;
  title: string;
  /** Shown beside the title, e.g. when the surface isn't on the current page. */
  description?: string;
  icon: ReactNode;
  position: Point;
  /** Called with the palette's new top-left while it is being dragged. */
  onMove: (position: Point) => void;
  visible: boolean;
  enterDelayMs: number;
  headerAction?: ReactNode;
  maxHeight?: number;
  className?: string;
  ref?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  const setFocusedSurface = useCustomizeInterfaceStore((store) => store.setFocusedSurface);
  const [minimized, setMinimized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragOffsetRef = useRef<{ dx: number; dy: number; width: number } | null>(null);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, input, a, [role=button]")) return;
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragOffsetRef.current = {
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      width: rect.width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const offset = dragOffsetRef.current;
    if (!offset) return;
    const maxX = Math.max(PALETTE_MARGIN, window.innerWidth - offset.width - PALETTE_MARGIN);
    // Keep the header reachable even when dragged low.
    const maxY = Math.max(PALETTE_MARGIN, window.innerHeight - 48);
    onMove({
      x: Math.min(Math.max(event.clientX - offset.dx, PALETTE_MARGIN), maxX),
      y: Math.min(Math.max(event.clientY - offset.dy, PALETTE_MARGIN), maxY),
    });
  };
  const endDrag = () => {
    dragOffsetRef.current = null;
    setDragging(false);
  };

  const style: CSSProperties = {
    transform: `translate3d(${position.x}px, ${position.y}px, 0) scale(${visible ? 1 : 0.97})`,
    transitionDelay: visible ? `${enterDelayMs}ms` : "0ms",
  };

  return (
    <section
      ref={ref}
      aria-label={`${title} customization`}
      data-customize-palette={surface}
      className={cn(
        "dialog-glass pointer-events-auto fixed top-0 left-0 z-[105] flex w-72 origin-top flex-col overflow-hidden rounded-xl border text-popover-foreground shadow-lg/5",
        // Opacity and scale enter; transform also carries the palette when
        // its surface moves. Dragging tracks the pointer directly.
        !dragging &&
          "transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-opacity",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
        className,
      )}
      style={style}
      onPointerEnter={() => setFocusedSurface(surface)}
      onPointerLeave={() => setFocusedSurface(null)}
      onFocus={() => setFocusedSurface(surface)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusedSurface(null);
        }
      }}
    >
      <div
        className={cn(
          "flex touch-none items-center gap-2 py-2 ps-2.5 pe-1.5 select-none",
          dragging ? "cursor-grabbing" : "cursor-grab",
          !minimized && "border-b border-border/70",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <CustomizeMark icon={icon} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="shrink-0 truncate text-sm font-medium">{title}</h2>
          {description ? (
            <p className="truncate text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {headerAction}
        <Button
          aria-expanded={!minimized}
          aria-label={minimized ? `Expand ${title}` : `Fold ${title}`}
          size="icon-xs"
          variant="ghost"
          onClick={() => setMinimized((value) => !value)}
        >
          {minimized ? <ChevronDownIcon /> : <ChevronUpIcon />}
        </Button>
      </div>
      {minimized ? null : (
        <div
          data-palette-body
          className="min-h-0 flex-1 overflow-y-auto px-3 py-3 [scrollbar-gutter:stable]"
          style={maxHeight !== undefined ? { maxHeight } : undefined}
        >
          <div data-palette-content className="space-y-4">
            {children}
          </div>
        </div>
      )}
    </section>
  );
}
