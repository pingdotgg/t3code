import { PlusIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { CommandDialogTrigger } from "./ui/command";
import { Kbd } from "./ui/kbd";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

interface SidebarTopActionsProps {
  readonly commandPaletteShortcutLabel: string | null;
  readonly newThread?: {
    readonly disabled: boolean;
    readonly onClick: () => void;
  };
}

export function SidebarTopActions({
  commandPaletteShortcutLabel,
  newThread,
}: SidebarTopActionsProps) {
  const navigate = useNavigate();

  return (
    <SidebarGroup className="px-2 pt-0 pb-1">
      <SidebarMenu>
        <SidebarMenuItem>
          <CommandDialogTrigger
            render={
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5 text-[length:var(--app-sidebar-font-size)] text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
                data-testid="command-palette-trigger"
              />
            }
          >
            <SearchIcon className="size-3.5" />
            <span className="flex-1 truncate text-left">Search</span>
            {commandPaletteShortcutLabel ? (
              <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[length:var(--app-sidebar-font-size)]">
                {commandPaletteShortcutLabel}
              </Kbd>
            ) : null}
          </CommandDialogTrigger>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-1.5 text-[length:var(--app-sidebar-font-size)] text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
            onClick={() => void navigate({ to: "/skills" })}
          >
            <SparklesIcon className="size-3.5" />
            <span className="flex-1 truncate text-left">Skills</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {newThread ? (
          <SidebarMenuItem>
            <SidebarMenuButton
              disabled={newThread.disabled}
              size="sm"
              className="gap-2 px-2 py-1.5 text-[length:var(--app-sidebar-font-size)] text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
              onClick={newThread.onClick}
            >
              <PlusIcon className="size-3.5" />
              <span className="flex-1 truncate text-left">New thread</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </SidebarGroup>
  );
}
