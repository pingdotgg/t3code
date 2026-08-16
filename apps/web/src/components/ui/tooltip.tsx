import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { useRef } from "react";

import { cn } from "~/lib/utils";

const TooltipCreateHandle = TooltipPrimitive.createHandle;

const TooltipProvider = TooltipPrimitive.Provider;

type TooltipProps = TooltipPrimitive.Root.Props & {
  preserveOnNestedTriggerHover?: boolean;
};

function hasHoveredNestedTooltipTrigger(parentTrigger: Element | null, target: EventTarget | null) {
  if (!parentTrigger) return false;
  if (!target || typeof (target as Element).closest !== "function") {
    return parentTrigger.querySelector('[data-slot="tooltip-trigger"]:hover') !== null;
  }
  const nestedTrigger = (target as Element).closest<HTMLElement>('[data-slot="tooltip-trigger"]');
  return (
    nestedTrigger !== null &&
    nestedTrigger !== parentTrigger &&
    parentTrigger.contains(nestedTrigger) &&
    nestedTrigger.matches(":hover")
  );
}

function Tooltip({ preserveOnNestedTriggerHover = false, onOpenChange, ...props }: TooltipProps) {
  const triggerRef = useRef<Element | null>(null);

  return (
    <TooltipPrimitive.Root
      onOpenChange={(open, eventDetails) => {
        if (open && eventDetails.trigger) {
          triggerRef.current = eventDetails.trigger;
        }
        if (
          !open &&
          preserveOnNestedTriggerHover &&
          hasHoveredNestedTooltipTrigger(triggerRef.current, eventDetails.event.target)
        ) {
          eventDetails.cancel();
          return;
        }
        onOpenChange?.(open, eventDetails);
        if (!open && !eventDetails.isCanceled) {
          triggerRef.current = null;
        }
      }}
      {...props}
    />
  );
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

type TooltipPopupProps = TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  variant?: "default" | "glass";
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
};

function TooltipPopup({
  className,
  align = "center",
  sideOffset = 4,
  side = "top",
  variant = "default",
  anchor,
  children,
  ...props
}: TooltipPopupProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        anchor={anchor}
        className="pointer-events-none z-[140] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none"
        data-slot="tooltip-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md text-popover-foreground text-xs transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            variant === "glass"
              ? "dropdown-glass shadow-xl shadow-black/25 before:hidden"
              : "border bg-popover not-dark:bg-clip-padding shadow-md/5",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <TooltipPrimitive.Viewport
            className="relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)] data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity"
            data-slot="tooltip-viewport"
          >
            {children}
          </TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

function TooltipCardPopup({ className, sideOffset = 8, style, ...props }: TooltipPopupProps) {
  return (
    <TooltipPopup
      className={cn(
        "dropdown-glass max-w-80 border-0! text-left whitespace-normal shadow-lg/10 before:hidden dark:shadow-none",
        className,
      )}
      sideOffset={sideOffset}
      style={{
        background:
          "color-mix(in srgb, var(--popover) 18%, color-mix(in srgb, var(--popover) var(--glass-opacity), transparent))",
        ...style,
      }}
      {...props}
    />
  );
}

export {
  TooltipCreateHandle,
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  TooltipCardPopup,
  hasHoveredNestedTooltipTrigger,
};
