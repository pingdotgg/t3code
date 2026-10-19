"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "~/lib/utils";

const PopoverCreateHandle = PopoverPrimitive.createHandle;

const Popover = PopoverPrimitive.Root;

function PopoverTrigger({ className, children, ...props }: PopoverPrimitive.Trigger.Props) {
  return (
    <PopoverPrimitive.Trigger className={className} data-slot="popover-trigger" {...props}>
      {children}
    </PopoverPrimitive.Trigger>
  );
}

const popoverPopupWidthClassName = {
  auto: "",
  sm: "w-64",
  md: "w-80",
  lg: "w-96",
} as const;

const popoverViewportPaddingClassName = {
  default: "py-4 [--viewport-inline-padding:--spacing(4)]",
  compact: "py-2 [--viewport-inline-padding:--spacing(3)]",
  none: "rounded-[calc(var(--radius-lg)-1px)] py-0 [--viewport-inline-padding:0px]",
} as const;

function PopoverPopup({
  children,
  className,
  padding = "default",
  variant = "default",
  width = "auto",
  side = "bottom",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  collisionAvoidance,
  tooltipStyle = false,
  keepMounted = false,
  anchor,
  touchBackdrop = false,
  ...props
}: PopoverPrimitive.Popup.Props & {
  padding?: keyof typeof popoverViewportPaddingClassName;
  variant?: "default" | "panel";
  side?: PopoverPrimitive.Positioner.Props["side"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
  collisionAvoidance?: PopoverPrimitive.Positioner.Props["collisionAvoidance"];
  tooltipStyle?: boolean;
  keepMounted?: PopoverPrimitive.Portal.Props["keepMounted"];
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
  width?: keyof typeof popoverPopupWidthClassName;
  touchBackdrop?: boolean;
}) {
  // Viewport rekeys its children when the active trigger clears on close. Persistent
  // single-trigger forms need a stable container to retain drafts and submit guards.
  const Viewport = keepMounted ? "div" : PopoverPrimitive.Viewport;
  return (
    <PopoverPrimitive.Portal keepMounted={keepMounted}>
      {touchBackdrop ? (
        // A non-modal popover closes on an outside tap and lets that tap reach the
        // control under the finger. On touch screens the backdrop takes the tap, so
        // tapping away only closes the popover, as it does for modal menus and selects.
        <PopoverPrimitive.Backdrop
          className="fixed inset-0 z-[130] hidden pointer-coarse:block"
          data-slot="popover-backdrop"
        />
      ) : null}
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        collisionPadding={variant === "panel" ? 0 : undefined}
        className={cn(
          "h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-transform data-instant:transition-none",
          variant === "panel"
            ? "z-(--z-sheet) w-[min(calc(var(--thread-details-panel-width)+--spacing(4)),calc(var(--anchor-width)---spacing(2)))] transition-[top] duration-150 ease-out data-instant:transition-[top] motion-reduce:transition-none motion-reduce:data-instant:transition-none"
            : "z-[130]",
        )}
        data-slot="popover-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg text-popover-foreground outline-none transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] has-data-[slot=calendar]:rounded-xl has-data-[slot=calendar]:before:rounded-[calc(var(--radius-xl)-1px)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            variant !== "panel" && "dropdown-glass",
            tooltipStyle &&
              "w-fit text-balance rounded-md text-xs shadow-md/5 before:rounded-[calc(var(--radius-md)-1px)]",
            !tooltipStyle &&
              variant !== "panel" &&
              "shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
            width !== "auto" && ["max-w-[calc(100vw-2rem)]", popoverPopupWidthClassName[width]],
            variant === "panel" &&
              "w-full overflow-visible rounded-none border-0 bg-transparent shadow-none before:hidden [backdrop-filter:none] [-webkit-backdrop-filter:none]",
            className,
          )}
          data-slot="popover-popup"
          {...props}
        >
          <Viewport
            className={cn(
              "relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) has-data-[slot=calendar]:p-2 data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity",
              tooltipStyle && padding === "default"
                ? "py-1 [--viewport-inline-padding:--spacing(2)]"
                : popoverViewportPaddingClassName[padding],
              !tooltipStyle && "not-data-transitioning:overflow-y-auto",
              variant === "panel" &&
                "overflow-visible py-2 [--viewport-inline-padding:--spacing(2)]",
            )}
            data-slot="popover-viewport"
          >
            {children}
          </Viewport>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      className={cn("font-semibold text-sm leading-none", className)}
      data-slot="popover-title"
      {...props}
    />
  );
}

export {
  PopoverCreateHandle,
  Popover,
  PopoverTrigger,
  PopoverPopup,
  PopoverPopup as PopoverContent,
  PopoverTitle,
  PopoverClose,
};
