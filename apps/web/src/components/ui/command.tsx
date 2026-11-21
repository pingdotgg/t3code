import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog";
import { SearchIcon } from "lucide-react";
import { useRef } from "react";
import type * as React from "react";
import { cn } from "~/lib/utils";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";
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
import { DIALOG_BACKDROP_CLASS, DIALOG_POPUP_CLASS } from "~/components/ui/dialog-styles";
import { Button } from "~/components/ui/button";
import { definePluginComponent } from "~/plugins/features";

const CommandDialogTrigger = definePluginComponent(
  "component:components/ui/command/CommandDialogTrigger",
  PluginOriginalCommandDialogTrigger,
);
const CommandDialogBackdrop = definePluginComponent(
  "component:components/ui/command/CommandDialogBackdrop",
  PluginOriginalCommandDialogBackdrop,
);
const CommandDialogViewport = definePluginComponent(
  "component:components/ui/command/CommandDialogViewport",
  PluginOriginalCommandDialogViewport,
);
const CommandDialogPopup = definePluginComponent(
  "component:components/ui/command/CommandDialogPopup",
  PluginOriginalCommandDialogPopup,
);
const Command = definePluginComponent(
  "component:components/ui/command/Command",
  PluginOriginalCommand,
);
const CommandInput = definePluginComponent(
  "component:components/ui/command/CommandInput",
  PluginOriginalCommandInput,
);
const CommandList = definePluginComponent(
  "component:components/ui/command/CommandList",
  PluginOriginalCommandList,
);
const CommandListVirtualized = definePluginComponent(
  "component:components/ui/command/CommandListVirtualized",
  PluginOriginalCommandListVirtualized,
);
const CommandListHeading = definePluginComponent(
  "component:components/ui/command/CommandListHeading",
  PluginOriginalCommandListHeading,
);
const CommandPanel = definePluginComponent(
  "component:components/ui/command/CommandPanel",
  PluginOriginalCommandPanel,
);
const CommandGroup = definePluginComponent(
  "component:components/ui/command/CommandGroup",
  PluginOriginalCommandGroup,
);
const CommandGroupLabel = definePluginComponent(
  "component:components/ui/command/CommandGroupLabel",
  PluginOriginalCommandGroupLabel,
);
const CommandCollection = definePluginComponent(
  "component:components/ui/command/CommandCollection",
  PluginOriginalCommandCollection,
);
const CommandItem = definePluginComponent(
  "component:components/ui/command/CommandItem",
  PluginOriginalCommandItem,
);
const CommandShortcut = definePluginComponent(
  "component:components/ui/command/CommandShortcut",
  PluginOriginalCommandShortcut,
);
const CommandFooter = definePluginComponent(
  "component:components/ui/command/CommandFooter",
  PluginOriginalCommandFooter,
);
const CommandFooterAction = definePluginComponent(
  "component:components/ui/command/CommandFooterAction",
  PluginOriginalCommandFooterAction,
);

const PluginOriginalCommandDialog = CommandDialogPrimitive.Root;
const CommandDialog = definePluginComponent(
  "component:components/ui/command/CommandDialog",
  PluginOriginalCommandDialog,
);

const PluginOriginalCommandDialogPortal = CommandDialogPrimitive.Portal;
const CommandDialogPortal = definePluginComponent(
  "component:components/ui/command/CommandDialogPortal",
  PluginOriginalCommandDialogPortal,
);

function PluginOriginalCommandDialogTrigger(props: CommandDialogPrimitive.Trigger.Props) {
  return <CommandDialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />;
}

function PluginOriginalCommandDialogBackdrop({
  className,
  ...props
}: CommandDialogPrimitive.Backdrop.Props) {
  return (
    <CommandDialogPrimitive.Backdrop
      className={cn(DIALOG_BACKDROP_CLASS, "data-ending-style:pointer-events-none", className)}
      data-slot="command-dialog-backdrop"
      {...props}
    />
  );
}

function PluginOriginalCommandDialogViewport({
  className,
  ...props
}: CommandDialogPrimitive.Viewport.Props) {
  // Short desktop windows would put the search field under the native window controls.
  const nativeTitlebarHeight = useNativeTitlebarHeight();
  const titlebarStyle = {
    "--command-titlebar-height": `${nativeTitlebarHeight}px`,
  } as React.CSSProperties;
  return (
    <CommandDialogPrimitive.Viewport
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 [-webkit-app-region:no-drag] pt-[max(--spacing(4),4vh,calc(var(--command-titlebar-height)+--spacing(2)))] pb-[max(--spacing(4),4vh)] sm:pt-[max(10vh,calc(var(--command-titlebar-height)+--spacing(2)))] sm:pb-[10vh]",
        className,
      )}
      data-slot="command-dialog-viewport"
      style={titlebarStyle}
      {...props}
    />
  );
}

function PluginOriginalCommandDialogPopup({
  className,
  children,
  onBackdropPointerDown,
  ...props
}: CommandDialogPrimitive.Popup.Props & {
  onBackdropPointerDown?: React.PointerEventHandler<HTMLDivElement>;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <CommandDialogPortal>
      <CommandDialogBackdrop onPointerDown={onBackdropPointerDown} />
      <CommandDialogViewport>
        <CommandDialogPrimitive.Popup
          // The first tabbable can be an input addon, such as a submenu's Back button.
          initialFocus={() => popupRef.current?.querySelector("input") ?? true}
          ref={popupRef}
          className={cn(
            DIALOG_POPUP_CLASS,
            "pointer-events-auto max-h-105 max-w-xl text-foreground data-ending-style:pointer-events-none",
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

function PluginOriginalCommand({
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

function PluginOriginalCommandInput({
  className,
  placeholder,
  ...props
}: React.ComponentProps<typeof AutocompleteInput>) {
  return (
    <div className="px-[var(--command-shell-inset)] py-1.5 [&_[data-slot=autocomplete-start-addon]]:ps-[calc(var(--command-shell-inset)+0.0625rem)]">
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

function PluginOriginalCommandList({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteList>) {
  return (
    <AutocompleteList
      className={cn("not-empty:scroll-py-2 not-empty:p-2", className)}
      data-slot="command-list"
      {...props}
    />
  );
}

function PluginOriginalCommandListVirtualized({
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

function PluginOriginalCommandListHeading({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteListHeading>) {
  return (
    <AutocompleteListHeading className={className} data-slot="command-group-label" {...props} />
  );
}

function PluginOriginalCommandPanel({ className, ...props }: React.ComponentProps<"div">) {
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

function PluginOriginalCommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteGroup>) {
  return <AutocompleteGroup className={className} data-slot="command-group" {...props} />;
}

function PluginOriginalCommandGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteGroupLabel>) {
  return (
    <AutocompleteGroupLabel className={className} data-slot="command-group-label" {...props} />
  );
}

function PluginOriginalCommandCollection({
  ...props
}: React.ComponentProps<typeof AutocompleteCollection>) {
  return <AutocompleteCollection data-slot="command-collection" {...props} />;
}

// Pass active to override primitive hover/keyboard highlights when the palette tracks its own row.
function PluginOriginalCommandItem({
  className,
  active,
  ...props
}: React.ComponentProps<typeof AutocompleteItem> & { active?: boolean }) {
  return (
    <AutocompleteItem
      className={cn(
        "py-1.5 data-selected:bg-foreground/[0.06] data-highlighted:bg-foreground/[0.09] data-highlighted:text-foreground [&[data-highlighted][data-selected]]:bg-foreground/[0.09] [&[data-highlighted][data-selected]]:text-foreground",
        active !== undefined &&
          "cursor-pointer hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit data-selected:bg-transparent data-selected:text-inherit [&[data-highlighted][data-selected]]:bg-transparent [&[data-highlighted][data-selected]]:text-inherit",
        active && "bg-accent! text-accent-foreground!",
        className,
      )}
      data-active={active || undefined}
      data-slot="command-item"
      {...props}
    />
  );
}

function PluginOriginalCommandShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
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

function PluginOriginalCommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] border-t border-foreground/[0.07] bg-foreground/[0.025] px-[var(--command-content-inset)] py-2.5 font-medium text-sm text-muted-foreground [&_[data-slot=kbd-group]]:font-sans [&_[data-slot=kbd]]:bg-foreground/[0.08] [&_[data-slot=kbd]]:text-foreground [&_[data-slot=kbd]]:ring-0",
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  );
}

function PluginOriginalCommandFooterAction({
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
