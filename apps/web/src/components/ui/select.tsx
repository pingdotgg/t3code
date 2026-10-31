import { mergeProps } from "@base-ui/react/merge-props";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "~/lib/utils";

const Select = SelectPrimitive.Root;

const selectTriggerVariants = cva(
  "relative pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 inline-flex cursor-pointer select-none items-center justify-between gap-2 border rounded-[var(--control-radius)] text-left text-label outline-none transition-[color,box-shadow,background-color] data-disabled:pointer-events-none data-disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      variant: {
        // The raised recipe; open and focused trade the rim for the ring stroke.
        default:
          "w-full min-w-36 surface-raised text-foreground [:hover,[data-pressed]]:not-data-popup-open:surface-raised-hover focus-visible:not-data-disabled:surface-focus data-popup-open:not-data-disabled:surface-focus aria-invalid:not-data-disabled:surface-invalid focus-visible:aria-invalid:not-data-disabled:surface-invalid-focus data-popup-open:aria-invalid:not-data-disabled:surface-invalid [&_svg:not([class*='text-'])]:text-muted-foreground",
        ghost:
          "border-transparent text-secondary-label focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring [:hover,[data-pressed],[data-popup-open]]:surface-ghost-hover [:hover,[data-pressed],[data-popup-open]]:text-foreground [&_svg:not([class*='text-'])]:text-muted-foreground",
      },
      // The end padding mirrors the start: the 14px chevron's ink sits 3.5px inside its
      // box, so its ink ends as far from the edge as the text starts (10px, or 8px small).
      size: {
        compact:
          "h-7 gap-1 rounded-md ps-[calc(--spacing(2)-1px)] pe-[calc(--spacing(1)-0.5px)] text-meta [&_svg:not([class*='size-'])]:size-3.5",
        default: "min-h-9 ps-[calc(--spacing(2.5)-1px)] pe-[calc(--spacing(1.5)-0.5px)] sm:min-h-8",
        sm: "min-h-8 gap-2 ps-[calc(--spacing(2.5)-1px)] pe-[calc(--spacing(1.5)-0.5px)] sm:min-h-7",
        xs: "h-7 gap-1 rounded-md ps-[calc(--spacing(2)-1px)] pe-[calc(--spacing(1)-0.5px)] text-meta sm:h-6 [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
    },
  },
);

/** A muted 14px icon before a select's value, such as a calendar before a duration. */
function SelectLeadingIcon({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground"
      data-slot="select-leading-icon"
    >
      {children}
    </span>
  );
}

function SelectTrigger({
  className,
  size = "default",
  variant = "default",
  children,
  icon,
  leadingIcon,
  ...props
}: SelectPrimitive.Trigger.Props &
  VariantProps<typeof selectTriggerVariants> & {
    icon?: React.ReactNode;
    /** Icon slot before the value; the chevron slot is `icon`. */
    leadingIcon?: React.ReactNode;
  }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(selectTriggerVariants({ size, variant }), className)}
      data-slot="select-trigger"
      {...props}
    >
      {leadingIcon ? <SelectLeadingIcon>{leadingIcon}</SelectLeadingIcon> : null}
      {children}
      <SelectPrimitive.Icon data-slot="select-icon">
        {icon ?? (
          <ChevronDownIcon className="size-3.5 text-muted-foreground in-data-popup-open:rotate-180" />
        )}
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectButton({
  className,
  size = "default",
  children,
  leadingIcon,
  render,
  ...props
}: useRender.ComponentProps<"button"> &
  Pick<VariantProps<typeof selectTriggerVariants>, "size"> & { leadingIcon?: React.ReactNode }) {
  const defaultProps = {
    className: cn(selectTriggerVariants({ size }), className),
    "data-slot": "select-trigger",
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: {
      ...mergeProps<"button">(defaultProps, props),
      children: (
        <>
          {leadingIcon ? <SelectLeadingIcon>{leadingIcon}</SelectLeadingIcon> : null}
          <span className="min-w-0 flex-1 truncate text-left">{children}</span>
          <ChevronDownIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground in-data-popup-open:rotate-180"
          />
        </>
      ),
    },
    render,
  });
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      className={cn("flex-1 truncate data-placeholder:text-placeholder", className)}
      data-slot="select-value"
      {...props}
    />
  );
}

// Items put their text 13px into the popup (1px border, p-1, px-2); a field trigger puts
// its text 10px in. The popup overhangs the trigger by the difference on both sides, so
// the item text continues the trigger's text line and the edges stay symmetric.
const SELECT_POPUP_OVERHANG = 3;

function SelectPopup({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset: alignOffsetProp,
  alignItemWithTrigger = true,
  matchTriggerWidth = true,
  anchor,
  ...props
}: SelectPrimitive.Popup.Props & {
  side?: SelectPrimitive.Positioner.Props["side"];
  sideOffset?: SelectPrimitive.Positioner.Props["sideOffset"];
  align?: SelectPrimitive.Positioner.Props["align"];
  alignOffset?: SelectPrimitive.Positioner.Props["alignOffset"];
  alignItemWithTrigger?: SelectPrimitive.Positioner.Props["alignItemWithTrigger"];
  matchTriggerWidth?: boolean;
  anchor?: SelectPrimitive.Positioner.Props["anchor"];
}) {
  const alignOffset =
    alignOffsetProp === undefined
      ? align === "center"
        ? 0
        : -SELECT_POPUP_OVERHANG
      : alignOffsetProp;
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        align={align}
        alignItemWithTrigger={alignItemWithTrigger}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-[130] select-none"
        data-slot="select-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <SelectPrimitive.Popup
          className="origin-(--transform-origin) rounded-card text-foreground outline-none"
          data-slot="select-popup"
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow
            className="top-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:top-px before:h-[200%] before:rounded-t-[calc(var(--radius-card)-1px)] before:bg-linear-to-b before:from-50% before:from-popover"
            data-slot="select-scroll-up-arrow"
          >
            <ChevronUpIcon className="relative size-4.5 sm:size-4" />
          </SelectPrimitive.ScrollUpArrow>
          <div
            className="surface-popover kbd-in-popover relative h-full rounded-card"
            style={
              matchTriggerWidth
                ? { minWidth: `calc(var(--anchor-width) + ${2 * SELECT_POPUP_OVERHANG}px)` }
                : undefined
            }
          >
            <SelectPrimitive.List
              className={cn("max-h-(--available-height) overflow-y-auto p-1", className)}
              data-slot="select-list"
            >
              {children}
            </SelectPrimitive.List>
          </div>
          <SelectPrimitive.ScrollDownArrow
            className="bottom-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:bottom-px before:h-[200%] before:rounded-b-[calc(var(--radius-card)-1px)] before:bg-linear-to-t before:from-50% before:from-popover"
            data-slot="select-scroll-down-arrow"
          >
            <ChevronDownIcon className="relative size-4.5 sm:size-4" />
          </SelectPrimitive.ScrollDownArrow>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  hideIndicator: _hideIndicator = false,
  ...props
}: SelectPrimitive.Item.Props & {
  hideIndicator?: boolean;
}) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "flex min-h-8 cursor-pointer items-center rounded-item px-2 py-1 text-label text-foreground outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:surface-selected-soft data-highlighted:text-strong-foreground data-selected:surface-selected-soft data-selected:text-strong-foreground data-disabled:opacity-45 sm:min-h-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemText
        className="min-w-0 flex-1 [&_svg:not([class*='text-'])]:text-muted-foreground"
        data-slot="select-item-text"
      >
        {children}
      </SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectGroup(props: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectGroupLabel(props: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      className="px-2 py-1.5 text-meta text-dim-foreground"
      data-slot="select-group-label"
      {...props}
    />
  );
}

export {
  Select,
  SelectTrigger,
  SelectButton,
  SelectValue,
  SelectPopup,
  SelectPopup as SelectContent,
  SelectItem,
  SelectGroup,
  SelectGroupLabel,
};
