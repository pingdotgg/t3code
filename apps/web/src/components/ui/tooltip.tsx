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
import { isReturningFocus } from "./focus-return";

// Base UI's default, restated because a padding object zeroes the sides it omits.
const COLLISION_PADDING = 5;

const TooltipProvider = TooltipPrimitive.Provider;

type TooltipActionsRef = RefObject<TooltipPrimitive.Root.Actions | null>;

// The compiler freezes context values; update hovered tooltips through calls instead of shared ref writes.
function createTooltipHoverTracker(suppressHoverWhileScrolling: boolean) {
  let lastScrollAt = Number.NEGATIVE_INFINITY;
  let hovered: { trigger: HTMLElement; owner: object; close: () => void } | null = null;
  return {
    hover(trigger: HTMLElement, owner: object, close: () => void) {
      hovered = { trigger, owner, close };
    },
    release(owner: object) {
      if (hovered?.owner === owner) hovered = null;
    },
    suppressHover() {
      return suppressHoverWhileScrolling && Date.now() - lastScrollAt < 150;
    },
    dismissUnfocused() {
      lastScrollAt = Date.now();
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
  suppressHoverWhileScrolling = false,
  ...props
}: ComponentProps<"div"> & {
  holdPositionOnExit?: boolean;
  suppressHoverWhileScrolling?: boolean;
}) {
  const [tracker] = useState(() => createTooltipHoverTracker(suppressHoverWhileScrolling));
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
          if (open && details.reason === "trigger-hover" && tracker.suppressHover()) {
            details.cancel();
          }
          props.onOpenChange?.(open, details);
          if (!open && !details.isCanceled) tracker.release(actionsRef);
        }}
      />
    </TooltipHoverContext>
  );
}

function TooltipTrigger({ onFocus, ...props }: TooltipPrimitive.Trigger.Props) {
  const handleFocus: TooltipPrimitive.Trigger.Props["onFocus"] = (event) => {
    onFocus?.(event);
    if (isReturningFocus(event.currentTarget.ownerDocument)) event.preventBaseUIHandler();
  };
  const tracker = useTooltipScrollTracker();
  const actionsRef = use(TooltipHoverContext);
  if (!tracker || !actionsRef) {
    return (
      <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} onFocus={handleFocus} />
    );
  }
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onFocus={handleFocus}
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
        "pointer-events-none z-[140] max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none motion-reduce:transition-none",
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
  /** `code` renders monospace content that breaks anywhere, for paths and commands.
   * A Kbd inside uses the tooltip's contextual keycap colors. */
  variant?: "default" | "popover" | "code" | "thread";
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPositioner align={align} anchor={anchor} side={side} sideOffset={sideOffset}>
        <TooltipPrimitive.Popup
          className={cn(
            "kbd-in-popover relative flex origin-(--transform-origin) rounded-item font-normal text-popover-foreground text-xs transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 motion-reduce:transition-none",
            // popover floats over media with the popover recipe.
            variant === "popover" || variant === "thread" ? "surface-popover" : "surface-tooltip",
            variant === "thread" && "rounded-card",
            // One wrap width for prose on a 16px line, so a one-line tooltip is a whole 26px;
            // code dumps get more room and break anywhere.
            variant === "code"
              ? "max-w-120 wrap-anywhere text-left font-mono text-caption leading-relaxed"
              : "max-w-80 wrap-anywhere whitespace-normal leading-4",
            className,
          )}
          data-slot="tooltip-popup"
          data-variant={variant}
          {...props}
        >
          <div
            className="min-w-0 px-2 py-1 in-data-[variant=thread]:p-3"
            data-slot="tooltip-viewport"
          >
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
