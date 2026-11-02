import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { buttonVariants } from "./button";
import { renderClosingPositioner } from "./closing-positioner";
import { Input, type InputProps } from "./input";
import { Spinner } from "./spinner";
import { RELAXED_PICKER_CLASS } from "./picker-styles";

export const MENU_ITEM_ROW_CLASS =
  "[&>svg]:-mx-0.5 flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-control px-2.5 py-1 text-control text-foreground outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:surface-selected-soft data-inset:ps-8 data-[variant=destructive]:text-destructive-foreground data-highlighted:not-data-[variant=destructive]:text-strong-foreground data-selected:surface-selected-soft data-selected:text-strong-foreground data-disabled:opacity-45 sm:min-h-8 [&>svg:not([class*='size-'])]:size-4.5 sm:[&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='text-'])]:text-muted-foreground data-highlighted:[&>svg:not([class*='text-'])]:text-foreground data-selected:[&>svg:not([class*='text-'])]:text-foreground data-[variant=destructive]:[&>svg:not([class*='text-'])]:text-current [&>svg]:pointer-events-none [&>svg]:shrink-0";

export const MENU_SUB_TRIGGER_ROW_CLASS =
  "[&>svg:not(:last-child)]:-mx-0.5 flex min-h-8 cursor-pointer items-center gap-2 rounded-control px-2.5 py-1 text-control text-foreground outline-none data-disabled:cursor-not-allowed data-disabled:pointer-events-none data-highlighted:surface-selected-soft data-popup-open:surface-selected-soft data-inset:ps-8 data-highlighted:text-strong-foreground data-popup-open:text-strong-foreground data-disabled:opacity-45 sm:min-h-8 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:pointer-events-none [&>svg]:shrink-0";

const Menu = MenuPrimitive.Root;

function MenuTrigger({ className, children, ...props }: MenuPrimitive.Trigger.Props) {
  return (
    <MenuPrimitive.Trigger className={className} data-slot="menu-trigger" {...props}>
      {children}
    </MenuPrimitive.Trigger>
  );
}

function MenuPopup({
  children,
  className,
  sideOffset = 4,
  align = "center",
  alignOffset,
  side = "bottom",
  collisionAvoidance,
  anchor,
  keepMounted = false,
  width = "default",
  variant = "default",
  spacing = "default",
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  side?: MenuPrimitive.Positioner.Props["side"];
  collisionAvoidance?: MenuPrimitive.Positioner.Props["collisionAvoidance"];
  anchor?: MenuPrimitive.Positioner.Props["anchor"];
  keepMounted?: boolean;
  width?: "default" | "content" | "wide";
  variant?: "default" | "scope";
  spacing?: "default" | "relaxed" | "compact";
}) {
  return (
    <MenuPrimitive.Portal keepMounted={keepMounted}>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        className="z-[130]"
        data-slot="menu-positioner"
        render={renderClosingPositioner}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            "surface-popover kbd-in-popover relative flex origin-(--transform-origin) rounded-card outline-none focus:outline-none",
            variant === "scope" &&
              "rounded-pane [&_[data-slot=menu-radio-item]]:min-h-7 [&_[data-slot=menu-sub-trigger]]:min-h-7 [&_[data-slot=menu-radio-item]:not([data-checked]):not([data-highlighted])]:text-muted-foreground [&_[data-slot=menu-radio-item-indicator]>svg]:size-3",
            spacing === "relaxed" && RELAXED_PICKER_CLASS,
            spacing === "compact" &&
              "[&_[data-slot=menu-radio-item]]:min-h-7.5 [&_[data-slot=menu-radio-item]]:rounded-item [&_[data-slot=menu-radio-item]]:px-2 [&_[data-slot=menu-radio-item]]:py-1.5",
            // Electron drag hit-testing ignores z-index; opt portaled menus out to keep overlapping rows
            // hoverable.
            "[-webkit-app-region:no-drag]",
            "max-w-[calc(100vw-2rem)]",
            width === "content"
              ? "w-max min-w-0"
              : width === "wide"
                ? "w-60"
                : "min-w-[min(10rem,calc(100vw-2rem))]",
            className,
          )}
          data-slot="menu-popup"
          {...props}
        >
          <div
            className={cn(
              "max-h-(--available-height) flex w-full flex-col gap-px overflow-y-auto",
              variant === "scope" || spacing === "compact" ? "p-1" : "p-1.5",
            )}
          >
            {children}
          </div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/** A menu's filter field, drawn like `ComboboxSearchInput` so every searchable popup matches. */
function MenuSearchInput({
  busy = false,
  onKeyDown,
  ...props
}: Omit<InputProps, "className" | "size" | "unstyled" | "nativeInput"> & { busy?: boolean }) {
  return (
    <div className="min-w-0 shrink-0 px-2 pt-1.5 pb-1">
      <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
        {busy ? (
          <Spinner
            aria-hidden="true"
            size="md"
            tone="muted"
            className="pointer-events-none absolute top-1.5 left-0"
          />
        ) : (
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
          />
        )}
        <Input
          {...props}
          className="rounded-none bg-transparent text-prompt [&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
          size="sm"
          unstyled
          onKeyDown={(event) => {
            // Menu typeahead would otherwise take the letters; arrows still reach the items.
            if (event.key !== "ArrowDown" && event.key !== "Escape") event.stopPropagation();
            onKeyDown?.(event);
          }}
        />
      </div>
    </div>
  );
}

function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

/**
 * A menu row: muted icon, label, then trailing meta or a MenuShortcut. Pass
 * `selected` for the current value (the selected fill, strong label and
 * icon) and `variant="destructive"` for the red item that ends a menu.
 */
function MenuItem({
  className,
  inset,
  density = "default",
  variant = "default",
  selected = false,
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  density?: "default" | "touch";
  variant?: "default" | "destructive" | "ghost";
  selected?: boolean;
}) {
  return (
    <MenuPrimitive.Item
      className={cn(
        MENU_ITEM_ROW_CLASS,
        variant === "ghost" &&
          buttonVariants({
            variant: "ghost",
            size: "compact",
            className: "h-auto min-h-7 w-full",
          }),
        density === "touch" && "min-h-10 sm:min-h-10",
        className,
      )}
      data-density={density}
      data-inset={inset}
      data-selected={selected ? "" : undefined}
      data-slot="menu-item"
      data-variant={variant}
      {...props}
    />
  );
}

function MenuItemLabel({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="menu-item-label"
      className={cn(
        "min-w-0 truncate in-data-[density=touch]:[text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:in-data-[density=touch]:py-[0.5em]",
        className,
      )}
      {...props}
    />
  );
}

function MenuCheckboxItem({
  className,
  children,
  checked,
  variant = "default",
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  variant?: "default" | "icon" | "switch";
}) {
  return (
    <MenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        "grid min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center gap-2 rounded-control py-1 ps-2.5 text-control text-foreground outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:surface-selected-soft data-highlighted:text-strong-foreground data-disabled:opacity-45 sm:min-h-8 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        variant === "switch"
          ? "grid-cols-[1fr_auto] gap-4 pe-1.5"
          : "grid-cols-[1rem_minmax(0,1fr)] pe-4",
        variant === "icon" && "grid-cols-[0.625rem_minmax(0,1fr)]",
        className,
      )}
      data-slot="menu-checkbox-item"
      {...props}
    >
      {variant === "switch" ? (
        <>
          <span className="col-start-1">{children}</span>
          <MenuPrimitive.CheckboxItemIndicator
            className="inline-flex h-[calc(var(--thumb-size)+2px)] w-[calc(var(--thumb-size)*2-2px)] shrink-0 items-center rounded-full border border-transparent p-0 outline-none [--thumb-size:--spacing(4)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring data-checked:surface-gloss-on data-unchecked:surface-well-switch data-disabled:opacity-64 sm:[--thumb-size:--spacing(3)]"
            keepMounted
          >
            <span className="pointer-events-none block aspect-square h-full in-[[data-slot=menu-checkbox-item][data-checked]]:origin-[var(--thumb-size)_50%] origin-left in-[[data-slot=menu-checkbox-item][data-checked]]:translate-x-[calc(var(--thumb-size)-4px)] in-[[data-slot=menu-checkbox-item]:active]:not-data-disabled:scale-x-110 in-[[data-slot=menu-checkbox-item]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.10)] rounded-(--thumb-size) surface-gloss-off-thumb in-[[data-slot=menu-checkbox-item][data-checked]]:surface-gloss-thumb [transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s]" />
          </MenuPrimitive.CheckboxItemIndicator>
        </>
      ) : (
        <>
          <MenuPrimitive.CheckboxItemIndicator
            className={cn("col-start-1", variant === "icon" && "-mx-0.5")}
          >
            <svg
              className={variant === "icon" ? "size-3.5" : undefined}
              fill="none"
              height="24"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.75"
              viewBox="0 0 24 24"
              width="24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
            </svg>
          </MenuPrimitive.CheckboxItemIndicator>
          <span className="col-start-2">{children}</span>
        </>
      )}
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({
  className,
  children,
  hideIndicator = false,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  hideIndicator?: boolean;
}) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        "[&_svg]:-mx-0.5 flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center gap-2 rounded-control px-2.5 py-1 text-control text-foreground outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:surface-selected-soft data-highlighted:text-strong-foreground data-checked:surface-selected-soft data-checked:text-foreground data-disabled:opacity-45 sm:min-h-8 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="menu-radio-item"
      {...props}
    >
      <span className="min-w-0 flex-1 [&:has([data-slot=menu-radio-item-indicator])+[data-slot=menu-radio-item-indicator]]:hidden">
        {children}
      </span>
      {!hideIndicator && <MenuRadioItemIndicator />}
    </MenuPrimitive.RadioItem>
  );
}

function MenuRadioItemIndicator({
  className,
  children,
  ...props
}: MenuPrimitive.RadioItemIndicator.Props) {
  return (
    <MenuPrimitive.RadioItemIndicator
      aria-hidden
      className={cn("flex shrink-0", className)}
      data-slot="menu-radio-item-indicator"
      {...props}
    >
      {children ?? <CheckIcon className="size-3.5 text-foreground" />}
    </MenuPrimitive.RadioItemIndicator>
  );
}

function MenuGroupLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      className={cn(
        "px-2 py-1.5 text-meta text-dim-foreground data-inset:ps-9 sm:data-inset:ps-8",
        className,
      )}
      data-inset={inset}
      data-slot="menu-label"
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn("mx-0 my-1 h-px bg-hairline", className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

function MenuShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "ms-auto font-sans text-caption text-dim-foreground tracking-widest",
        className,
      )}
      data-slot="menu-shortcut"
      {...props}
    />
  );
}

function MenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="menu-sub" {...props} />;
}

function MenuSubTrigger({
  className,
  inset,
  density = "default",
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
  density?: "default" | "touch";
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(
        // Exclude the last SVG so leading-icon margins preserve the chevron alignment.
        MENU_SUB_TRIGGER_ROW_CLASS,
        density === "touch" && "min-h-10 sm:min-h-10",
        className,
      )}
      data-density={density}
      data-inset={inset}
      data-slot="menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon className="-me-1 ms-auto size-3 text-dim-foreground" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function MenuSubPopup({
  className,
  sideOffset = 0,
  alignOffset,
  align = "start",
  ...props
}: MenuPrimitive.Popup.Props & {
  variant?: "default" | "scope";
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
}) {
  const defaultAlignOffset = align !== "center" ? -5 : undefined;

  return (
    <MenuPopup
      align={align}
      alignOffset={alignOffset ?? defaultAlignOffset}
      className={className}
      data-slot="menu-sub-content"
      side="inline-end"
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export {
  Menu,
  Menu as DropdownMenu,
  MenuTrigger,
  MenuTrigger as DropdownMenuTrigger,
  MenuPopup,
  MenuPopup as DropdownMenuContent,
  MenuSearchInput,
  MenuGroup,
  MenuGroup as DropdownMenuGroup,
  MenuItem,
  MenuItemLabel,
  MenuItem as DropdownMenuItem,
  MenuCheckboxItem,
  MenuCheckboxItem as DropdownMenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuRadioItem,
  MenuRadioItem as DropdownMenuRadioItem,
  MenuRadioItemIndicator,
  MenuGroupLabel,
  MenuGroupLabel as DropdownMenuLabel,
  MenuSeparator,
  MenuSeparator as DropdownMenuSeparator,
  MenuShortcut,
  MenuShortcut as DropdownMenuShortcut,
  MenuSub,
  MenuSub as DropdownMenuSub,
  MenuSubTrigger,
  MenuSubTrigger as DropdownMenuSubTrigger,
  MenuSubPopup,
  MenuSubPopup as DropdownMenuSubContent,
};
