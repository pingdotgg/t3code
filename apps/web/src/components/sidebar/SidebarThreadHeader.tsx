import { useGT } from "gt-react";
import { ChevronsLeftIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SidebarInput, SidebarMenuButton, useSidebar } from "../ui/sidebar";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export interface SidebarThreadHeaderProps {
  hasProjects: boolean;
  projectScope: ReactNode;
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  showNewThreadInProjectHint: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  hasProjects,
  projectScope,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const gt = useGT();
  const { toggleSidebar } = useSidebar();
  const resultsVisible = isSearching && searchResultCount > 0;
  // Shrinking results can remove the active option; never leave aria-activedescendant pointing at it.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? gt("New thread ({shortcut})", { shortcut: newThreadShortcutLabel })
    : gt("New thread");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-input/50 bg-popover/60 px-3 text-sm text-sidebar-muted-foreground transition-colors hover:border-input hover:bg-popover hover:text-sidebar-foreground focus-within:border-input focus-within:bg-popover focus-within:text-sidebar-foreground">
          <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
          <SidebarInput
            ref={searchInputRef}
            nativeInput
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={gt("Search", { $context: "search field placeholder" })}
            aria-label={gt("Search threads")}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={resultsVisible}
            aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
            aria-activedescendant={
              activeResultExists
                ? `sidebar-thread-search-result-${activeSearchResultIndex}`
                : undefined
            }
            className="min-w-0 flex-1"
          />
          {isSearching ? (
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              className="shrink-0"
              aria-label={gt("Clear thread search")}
              onClick={() => {
                onClearSearch();
                searchInputRef.current?.focus();
              }}
            >
              <XIcon className="size-3" />
            </Button>
          ) : null}
        </div>
        <SidebarHeaderIconButton
          label={gt("Collapse sidebar")}
          className="max-md:hidden"
          onClick={toggleSidebar}
        >
          <ChevronsLeftIcon />
        </SidebarHeaderIconButton>
      </div>
      <div className="flex items-center gap-2">
        <SharedTooltipTrigger
          render={
            <SidebarMenuButton
              type="button"
              aria-label={gt("New thread")}
              disabled={newThreadDisabled}
              onClick={onNewThread}
            />
          }
          label={
            showNewThreadInProjectHint ? (
              <span className="flex flex-col gap-0.5">
                <span>{newThreadLabel}</span>
                <span className="text-muted-foreground">
                  {newThreadInProjectShortcutLabel
                    ? gt("New thread in current project: Shift+click ({shortcut})", {
                        shortcut: newThreadInProjectShortcutLabel,
                      })
                    : gt("New thread in current project: Shift+click")}
                </span>
              </span>
            ) : (
              newThreadLabel
            )
          }
        >
          <SquarePenIcon />
          <span>{gt("New thread")}</span>
        </SharedTooltipTrigger>
        {hasProjects ? projectScope : null}
      </div>
    </div>
  );
}

export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <SharedTooltipTrigger
      render={
        <SidebarMenuButton
          size="icon"
          type="button"
          aria-label={label}
          {...rest}
          className={cn("relative size-9 shrink-0", className)}
        />
      }
      label={tooltip}
    >
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
      />
    </SharedTooltipTrigger>
  );
}
