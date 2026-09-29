import { PlusIcon, SearchIcon } from "lucide-react";

import { CommandDialogTrigger } from "./ui/command";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";
import { useSettings } from "../hooks/useSettings";

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
  const showSearch = useSettings((s) => s.sidebarShowSearch);
  const showNewThread = useSettings((s) => s.sidebarShowNewThread);
  const searchShowShortcut = useSettings((s) => s.sidebarSearchShowShortcut);
  const newThreadConfirm = useSettings((s) => s.sidebarNewThreadConfirm);

  if (!showSearch && !(showNewThread && newThread)) {
    return null;
  }

  const searchTitle =
    searchShowShortcut && commandPaletteShortcutLabel
      ? `Search (${commandPaletteShortcutLabel})`
      : "Search";

  const handleNewThreadClick = () => {
    if (!newThread) return;
    if (newThreadConfirm && !window.confirm("Create a new thread?")) return;
    newThread.onClick();
  };

  return (
    <SidebarGroup className="px-2 py-0">
      <SidebarMenu>
        {showSearch ? (
          <SidebarMenuItem>
            <CommandDialogTrigger
              render={
                <SidebarMenuButton
                  size="sm"
                  className="gap-2 px-2 py-1 text-[length:var(--app-sidebar-font-size)] text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
                  data-testid="command-palette-trigger"
                  // The shortcut stays discoverable on hover instead of parking a
                  // permanent badge in the row's right column.
                  title={searchTitle}
                />
              }
            >
              <SearchIcon className="size-[length:var(--app-sidebar-icon-size)]" />
              <span className="flex-1 truncate text-left">Search</span>
            </CommandDialogTrigger>
          </SidebarMenuItem>
        ) : null}
        {showNewThread && newThread ? (
          <SidebarMenuItem>
            <SidebarMenuButton
              disabled={newThread.disabled}
              size="sm"
              className="gap-2 px-2 py-1 text-[length:var(--app-sidebar-font-size)] text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-0"
              onClick={handleNewThreadClick}
            >
              <PlusIcon className="size-[length:var(--app-sidebar-icon-size)]" />
              <span className="flex-1 truncate text-left">New thread</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </SidebarGroup>
  );
}
