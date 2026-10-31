import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog";
import { SearchIcon } from "lucide-react";
import { useRef } from "react";
import type * as React from "react";
import { cn } from "~/lib/utils";
import {
  Autocomplete,
  AutocompleteCollection,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompleteListHeading,
  AutocompleteListVirtualized,
} from "~/components/ui/autocomplete";
import { COMMAND_DIALOG_POPUP_CLASS, DIALOG_BACKDROP_CLASS } from "~/components/ui/dialog-styles";
import { Button } from "~/components/ui/button";
import { Kbd, KbdGroup } from "~/components/ui/kbd";

const CommandDialog = CommandDialogPrimitive.Root;

const CommandDialogPortal = CommandDialogPrimitive.Portal;

function CommandDialogTrigger(props: CommandDialogPrimitive.Trigger.Props) {
  return <CommandDialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />;
}

function CommandDialogBackdrop({ className, ...props }: CommandDialogPrimitive.Backdrop.Props) {
  return (
    <CommandDialogPrimitive.Backdrop
      className={cn(DIALOG_BACKDROP_CLASS, className)}
      data-slot="command-dialog-backdrop"
      {...props}
    />
  );
}

function CommandDialogViewport({
  className,
  size = "default",
  ...props
}: CommandDialogPrimitive.Viewport.Props & { size?: "default" | "content" }) {
  return (
    <CommandDialogPrimitive.Viewport
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 py-[max(--spacing(4),4vh)]",
        size === "content" ? "sm:py-22" : "sm:py-24",
        className,
      )}
      data-slot="command-dialog-viewport"
      {...props}
    />
  );
}

function CommandDialogPopup({
  className,
  children,
  onBackdropPointerDown,
  surface = "palette",
  size = "default",
  ...props
}: CommandDialogPrimitive.Popup.Props & {
  onBackdropPointerDown?: React.PointerEventHandler<HTMLDivElement>;
  surface?: "palette" | "dialog";
  size?: "default" | "content";
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <CommandDialogPortal>
      <CommandDialogBackdrop onPointerDown={onBackdropPointerDown} />
      <CommandDialogViewport size={size}>
        <CommandDialogPrimitive.Popup
          // The first tabbable can be an input addon, such as a submenu's Back button.
          initialFocus={() => popupRef.current?.querySelector("input") ?? true}
          ref={popupRef}
          className={cn(
            COMMAND_DIALOG_POPUP_CLASS,
            surface === "dialog" && "[--surface-shadow:var(--dialog-shadow)]!",
            "pointer-events-auto max-h-[min(36rem,calc(100dvh-8rem))] text-foreground",
            size === "content" ? "max-w-150" : "max-w-140",
            className,
          )}
          data-slot="command-dialog-popup"
          data-surface={surface}
          {...props}
        >
          {children}
        </CommandDialogPrimitive.Popup>
      </CommandDialogViewport>
    </CommandDialogPortal>
  );
}

function Command({
  autoHighlight = "always",
  keepHighlight = true,
  ...props
}: React.ComponentProps<typeof Autocomplete>) {
  return (
    <Autocomplete
      autoHighlight={autoHighlight}
      inline
      keepHighlight={keepHighlight}
      open
      {...props}
    />
  );
}

function CommandInput({
  className,
  placeholder,
  iconSize = "default",
  endAddon,
  ...props
}: React.ComponentProps<typeof AutocompleteInput> & {
  iconSize?: "default" | "sm";
  /** Non-interactive hint pinned to the end of the field, such as the esc key. */
  endAddon?: React.ReactNode;
}) {
  // The glyph centers on the rows' icon column (phones draw it 18px, so it starts
  // 1px sooner) and the text starts on their label line: content inset, then a
  // 14px icon and 8px gap, less the field's 1px border.
  return (
    <div className="relative [box-shadow:inset_0_-1px_var(--divider)] px-[var(--command-shell-inset)] py-2 [&_[data-slot=autocomplete-start-addon]]:ps-[calc(var(--command-content-inset)-var(--command-shell-inset)-1px)] sm:[&_[data-slot=autocomplete-start-addon]]:ps-[calc(var(--command-content-inset)-var(--command-shell-inset))]">
      <AutocompleteInput
        autoFocus
        className={cn(
          "border-transparent! bg-transparent! bg-none! shadow-none! before:hidden has-focus-visible:ring-0 text-[0.9375rem] placeholder:text-placeholder *:data-[slot=autocomplete-input]:ps-[calc(var(--command-content-inset)-var(--command-shell-inset)+1.3125rem)]!",
          endAddon && "*:data-[slot=autocomplete-input]:pe-14!",
          className,
        )}
        placeholder={placeholder}
        size="lg"
        startAddon={
          <SearchIcon className={cn("text-icon-muted", iconSize === "sm" && "size-[15px]")} />
        }
        {...props}
      />
      {endAddon ? (
        <span className="pointer-events-none absolute inset-e-[var(--command-content-inset)] top-1/2 flex -translate-y-1/2">
          {endAddon}
        </span>
      ) : null}
    </div>
  );
}

function CommandList({
  className,
  inset = "default",
  ...props
}: React.ComponentProps<typeof AutocompleteList> & { inset?: "default" | "compact" }) {
  return (
    <AutocompleteList
      className={cn(
        inset === "compact"
          ? "not-empty:scroll-py-1 not-empty:p-1"
          : "not-empty:scroll-py-1.5 not-empty:p-1.5",
        className,
      )}
      data-slot="command-list"
      {...props}
    />
  );
}

function CommandListVirtualized({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteListVirtualized>) {
  return (
    <AutocompleteListVirtualized
      className={cn("flex max-h-[inherit] min-h-0 flex-col", className)}
      data-slot="command-list"
      {...props}
    />
  );
}

function CommandListHeading({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteListHeading>) {
  return (
    <AutocompleteListHeading
      className={cn("px-2.5 pt-2 pb-1 text-caption", className)}
      data-slot="command-group-label"
      {...props}
    />
  );
}

function CommandPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden rounded-t-pane not-has-[+[data-slot=command-footer]]:rounded-b-pane bg-transparent **:data-[slot=scroll-area-scrollbar]:mt-2 [touch-action:pan-y]",
        className,
      )}
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof AutocompleteGroup>) {
  return <AutocompleteGroup className={className} data-slot="command-group" {...props} />;
}

function CommandGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteGroupLabel>) {
  return (
    <AutocompleteGroupLabel
      className={cn("px-2.5 pt-2 pb-1 text-caption", className)}
      data-slot="command-group-label"
      {...props}
    />
  );
}

function CommandCollection({ ...props }: React.ComponentProps<typeof AutocompleteCollection>) {
  return <AutocompleteCollection data-slot="command-collection" {...props} />;
}

// Pass active to override primitive hover/keyboard highlights when the palette tracks its own row.
function CommandItem({
  className,
  active,
  spacing = "default",
  ...props
}: Omit<React.ComponentProps<typeof AutocompleteItem>, "automaticHighlight"> & {
  active?: boolean;
  spacing?: "default" | "composer";
}) {
  return (
    <AutocompleteItem
      automaticHighlight={false}
      className={cn(
        "min-h-8.5 px-2.5 py-1.5 text-control sm:min-h-8.5",
        spacing === "composer" && "px-2.5 gap-2.5",
        active === undefined
          ? "hover:surface-selected data-highlighted:surface-selected data-highlighted:text-strong-foreground data-selected:surface-selected data-selected:text-strong-foreground"
          : "cursor-pointer",
        active && "surface-selected text-strong-foreground",
        className,
      )}
      data-active={active || undefined}
      data-slot="command-item"
      {...props}
    />
  );
}

function CommandShortcut({ className, children, ...props }: React.ComponentProps<"kbd">) {
  const keys = typeof children === "string" ? children.split(/\+(?!$)|(?<=[⌃⌥⇧⌘])/) : [children];
  return (
    <KbdGroup className={cn("ms-auto", className)} data-slot="command-shortcut" {...props}>
      {keys.map((key, index) => {
        // oxlint-disable-next-line react/no-array-index-key -- Shortcut tokens can repeat; key badges have no local state.
        return <Kbd key={index}>{key}</Kbd>;
      })}
    </KbdGroup>
  );
}

function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-pane)-1px)] [box-shadow:inset_0_1px_var(--divider)] bg-transparent px-[var(--command-content-inset)] py-1.5 text-caption text-muted-foreground [&_[data-slot=kbd-group]]:font-sans",
        "in-[[data-slot=command-dialog-popup][data-surface=dialog]]:[--kbd-background:var(--kbd-fill)] in-[[data-slot=command-dialog-popup][data-surface=dialog]]:[--kbd-radius:var(--radius-badge)] in-[[data-slot=command-dialog-popup][data-surface=dialog]]:font-normal in-[[data-slot=command-dialog-popup][data-surface=dialog]]:text-dim-foreground",
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  );
}

function CommandFooterAction({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "variant">) {
  return (
    <Button
      {...props}
      variant="ghost-muted"
      size="xs"
      className={cn("h-auto px-2 text-meta hover:bg-transparent", className)}
    />
  );
}

export {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandFooter,
  CommandFooterAction,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandListHeading,
  CommandListVirtualized,
  CommandPanel,
  CommandShortcut,
};
