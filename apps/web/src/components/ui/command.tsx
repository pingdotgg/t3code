"use client";

import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog";
import { SearchIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "~/lib/utils";
import {
  Autocomplete,
  AutocompleteCollection,
  AutocompleteEmpty,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompleteSeparator,
} from "~/components/ui/autocomplete";
import { DIALOG_BACKDROP_CLASS, DIALOG_POPUP_CLASS } from "~/components/ui/dialog-styles";
import { Button } from "~/components/ui/button";

const CommandDialog = CommandDialogPrimitive.Root;

const CommandDialogPortal = CommandDialogPrimitive.Portal;

const CommandCreateHandle = CommandDialogPrimitive.createHandle;

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

function CommandDialogViewport({ className, ...props }: CommandDialogPrimitive.Viewport.Props) {
  return (
    <CommandDialogPrimitive.Viewport
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 py-[max(--spacing(4),4vh)] sm:py-[10vh]",
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
  ...props
}: CommandDialogPrimitive.Popup.Props & {
  onBackdropPointerDown?: React.PointerEventHandler<HTMLDivElement>;
}) {
  return (
    <CommandDialogPortal>
      <CommandDialogBackdrop onPointerDown={onBackdropPointerDown} />
      <CommandDialogViewport>
        <CommandDialogPrimitive.Popup
          className={cn(
            DIALOG_POPUP_CLASS,
            "pointer-events-auto max-h-105 max-w-xl text-foreground",
            className,
          )}
          data-slot="command-dialog-popup"
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
  wrapperClassName,
  placeholder,
  ...props
}: React.ComponentProps<typeof AutocompleteInput> & {
  wrapperClassName?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "px-[var(--command-shell-inset)] py-1.5 [&_[data-slot=autocomplete-start-addon]]:ps-[calc(var(--command-shell-inset)+0.0625rem)]",
        wrapperClassName,
      )}
    >
      <AutocompleteInput
        autoFocus
        className={cn(
          "border-transparent! bg-transparent! shadow-none before:hidden has-focus-visible:ring-0 placeholder:text-placeholder *:data-[slot=autocomplete-input]:ps-9! sm:*:data-[slot=autocomplete-input]:ps-[calc(var(--command-shell-inset)+1.5rem)]!",
          className,
        )}
        placeholder={placeholder}
        size="lg"
        startAddon={<SearchIcon className="translate-x-0.5 text-icon-muted" />}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof AutocompleteList>) {
  return (
    <AutocompleteList
      className={cn("not-empty:scroll-py-2 not-empty:p-2", className)}
      data-slot="command-list"
      {...props}
    />
  );
}

function CommandEmpty({ className, ...props }: React.ComponentProps<typeof AutocompleteEmpty>) {
  return (
    <AutocompleteEmpty
      className={cn("not-empty:py-6", className)}
      data-slot="command-empty"
      {...props}
    />
  );
}

function CommandPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden rounded-t-xl not-has-[+[data-slot=command-footer]]:rounded-b-2xl bg-transparent **:data-[slot=scroll-area-scrollbar]:mt-2 [touch-action:pan-y]",
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
    <AutocompleteGroupLabel className={className} data-slot="command-group-label" {...props} />
  );
}

function CommandCollection({ ...props }: React.ComponentProps<typeof AutocompleteCollection>) {
  return <AutocompleteCollection data-slot="command-collection" {...props} />;
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof AutocompleteItem>) {
  return (
    <AutocompleteItem
      className={cn(
        "py-1.5 data-selected:bg-foreground/[0.06] data-highlighted:bg-foreground/[0.09] data-highlighted:text-foreground [&[data-highlighted][data-selected]]:bg-foreground/[0.09] [&[data-highlighted][data-selected]]:text-foreground",
        className,
      )}
      data-slot="command-item"
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteSeparator>) {
  return (
    <AutocompleteSeparator
      className={cn("my-2", className)}
      data-slot="command-separator"
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-secondary-label text-xs tracking-widest",
        className,
      )}
      data-slot="command-shortcut"
      {...props}
    />
  );
}

function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] bg-foreground/[0.025] px-[var(--command-content-inset)] py-2.5 font-medium text-sm text-muted-foreground [&_[data-slot=kbd-group]]:font-sans [&_[data-slot=kbd]]:bg-foreground/[0.08] [&_[data-slot=kbd]]:text-foreground [&_[data-slot=kbd]]:ring-0",
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
      className={cn("h-auto px-2 text-xs hover:bg-transparent", className)}
    />
  );
}

export {
  CommandCreateHandle,
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandEmpty,
  CommandFooter,
  CommandFooterAction,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
  CommandShortcut,
};
