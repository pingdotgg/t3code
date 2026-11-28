import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";

// Base UI's default, restated because a padding object zeroes the sides it omits.
const COLLISION_PADDING = 5;

const TooltipProvider = TooltipPrimitive.Provider;

type TooltipActionsRef = RefObject<TooltipPrimitive.Root.Actions | null>;

// The compiler freezes context values; update hovered tooltips through calls instead of shared ref writes.
function createTooltipHoverTracker() {
  let hovered: { trigger: HTMLElement; owner: object; close: () => void } | null = null;
  return {
    hover(trigger: HTMLElement, owner: object, close: () => void) {
      hovered = { trigger, owner, close };
    },
    release(owner: object) {
      if (hovered?.owner === owner) hovered = null;
    },
    dismissUnfocused() {
      const tooltip = hovered;
      if (!tooltip) return;
      const focused = tooltip.trigger.ownerDocument.activeElement;
      if (focused && tooltip.trigger.contains(focused) && focused.matches(":focus-visible")) {
        return;
      }
      hovered = null;
      tooltip.close();
    },
  };
}

type TooltipHoverTracker = ReturnType<typeof createTooltipHoverTracker>;
const TooltipHoverContext = createContext<TooltipActionsRef | null>(null);
const TooltipScrollContext = createContext<{
  tracker: TooltipHoverTracker;
  holdPositionOnExit: boolean;
} | null>(null);

function TooltipScrollDismissArea({
  holdPositionOnExit = false,
  onScrollCapture,
  ...props
}: ComponentProps<"div"> & { holdPositionOnExit?: boolean }) {
  const [tracker] = useState(createTooltipHoverTracker);
  return (
    <TooltipScrollContext value={{ tracker, holdPositionOnExit }}>
      <div
        {...props}
        onScrollCapture={(event) => {
          onScrollCapture?.(event);
          tracker.dismissUnfocused();
        }}
      />
    </TooltipScrollContext>
  );
}

function Tooltip<Payload>(props: TooltipPrimitive.Root.Props<Payload>) {
  const tracker = useTooltipScrollTracker();
  const localActionsRef = useRef<TooltipPrimitive.Root.Actions | null>(null);
  const actionsRef = props.actionsRef ?? localActionsRef;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases this tooltip from the scroll tracker on unmount
  useEffect(() => () => tracker?.release(actionsRef), [actionsRef, tracker]);

  if (!tracker) return <TooltipPrimitive.Root {...props} />;
  return (
    <TooltipHoverContext value={actionsRef}>
      <TooltipPrimitive.Root
        {...props}
        actionsRef={actionsRef}
        onOpenChange={(open, details) => {
          props.onOpenChange?.(open, details);
          if (!open && !details.isCanceled) tracker.release(actionsRef);
        }}
      />
    </TooltipHoverContext>
  );
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  const tracker = useTooltipScrollTracker();
  const actionsRef = use(TooltipHoverContext);
  if (!tracker || !actionsRef) {
    return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
  }
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onMouseEnter={(event) => {
        props.onMouseEnter?.(event);
        // Base UI also cancels delayed hover opens through this action.
        tracker.hover(event.currentTarget, actionsRef, () => actionsRef.current?.close());
      }}
    />
  );
}

function TooltipPositioner(props: TooltipPrimitive.Positioner.Props) {
  const titlebarHeight = useNativeTitlebarHeight();
  const holdPositionOnExit = use(TooltipScrollContext)?.holdPositionOnExit;
  return (
    <TooltipPrimitive.Positioner
      className={cn(
        "pointer-events-none z-[140] max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none",
        // Defer repositioning until the popup's fade finishes when its trigger scrolls away.
        holdPositionOnExit && "data-closed:delay-(--default-transition-duration)",
      )}
      collisionPadding={{
        top: COLLISION_PADDING + titlebarHeight,
        right: COLLISION_PADDING,
        bottom: COLLISION_PADDING,
        left: COLLISION_PADDING,
      }}
      data-slot="tooltip-positioner"
      {...props}
    />
  );
}

function TooltipPopup({
  className,
  align = "center",
  sideOffset = 4,
  side = "top",
  variant = "default",
  anchor,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  variant?: "default" | "glass" | "code";
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPositioner align={align} anchor={anchor} side={side} sideOffset={sideOffset}>
        <TooltipPrimitive.Popup
          className={cn(
            "relative flex origin-(--transform-origin) rounded-md text-popover-foreground text-xs transition-[scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            variant === "glass"
              ? "dropdown-glass shadow-xl shadow-black/25 before:hidden"
              : "border bg-popover not-dark:bg-clip-padding shadow-md/5",
            variant === "code"
              ? "max-w-120 wrap-anywhere text-left font-mono text-[11px] leading-relaxed"
              : "max-w-80 wrap-anywhere whitespace-normal leading-snug",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <div className="min-w-0 px-2 py-1" data-slot="tooltip-viewport">
            {children}
          </div>
        </TooltipPrimitive.Popup>
      </TooltipPositioner>
    </TooltipPrimitive.Portal>
  );
}

/** The enclosing TooltipScrollDismissArea's tracker, for triggers that bypass TooltipTrigger. */
const useTooltipScrollTracker = () => use(TooltipScrollContext)?.tracker ?? null;

export {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  TooltipScrollDismissArea,
  useTooltipScrollTracker,
};
