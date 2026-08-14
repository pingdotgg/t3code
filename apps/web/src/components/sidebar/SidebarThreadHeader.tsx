/**
 * The sidebar header: one row holding project scope, search and new thread.
 *
 * The project selector owns the row's text and spans it; search and new-thread
 * sit at the end as a segmented icon pair; "New project" lives at the bottom of
 * the project menu.
 *
 * Search is a toggle rather than a mode: it opens a second row beneath the scope
 * row and pushes the thread list down, so the project you are scoped to stays
 * visible while you filter inside it. Toggling off clears the query, because a
 * hidden filter still narrowing the list is invisible state.
 */
import {
  ChevronDownIcon,
  FolderIcon,
  FolderPlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { cn } from "~/lib/utils";
import { Input } from "../ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon } from "../ProjectFavicon";

export interface SidebarThreadHeaderProps {
  projectGroups: readonly SidebarProjectSnapshot[];
  scopedProjectGroup: SidebarProjectSnapshot | null;
  projectScopeKey: string | null;
  onProjectScopeChange: (scopeKey: string | null) => void;
  projectScopeMenuOpen: boolean;
  onProjectScopeMenuOpenChange: (open: boolean) => void;
  onProjectSettings: (
    event: ReactMouseEvent<HTMLButtonElement>,
    projectGroup: SidebarProjectSnapshot,
  ) => void;
  onNewProject: () => void;
  /** Receives the click so Shift+click can skip the project picker. */
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

const ROW = "flex items-center gap-1";

const SEARCH_ROW_ID = "sidebar-thread-search-row";

const MENU_ITEM =
  "h-8 min-h-8 px-1 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2";

export function SidebarThreadHeader(props: SidebarThreadHeaderProps) {
  // Search is a toggle, not a mode swap: the field opens as a second row under
  // the scope row and pushes the thread list down, so the project you are
  // scoped to never disappears while you search inside it.
  const [searchOpen, setSearchOpen] = useState(false);
  // The scope menu is anchored to the whole row rather than to its trigger, so
  // the popup spans the sidebar's content width and keeps doing so when the
  // sidebar is resized.
  const rowRef = useRef<HTMLDivElement | null>(null);
  // A stray query would keep filtering an invisible list, so closing resets it.
  const closeSearch = () => {
    props.onClearSearch();
    setSearchOpen(false);
  };
  const toggleSearch = () => {
    if (searchOpen) {
      closeSearch();
      return;
    }
    setSearchOpen(true);
    window.requestAnimationFrame(() => props.searchInputRef.current?.focus());
  };

  return (
    <>
      <div ref={rowRef} className={ROW}>
        <Menu open={props.projectScopeMenuOpen} onOpenChange={props.onProjectScopeMenuOpenChange}>
          <MenuTrigger
            render={
              <SidebarMenuButton
                aria-label="Filter threads by project"
                className="min-w-0 flex-1 ps-[calc(var(--sidebar-row-content-inset)-1px)] focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
              />
            }
          >
            <ScopeIcon group={props.scopedProjectGroup} />
            <span className="min-w-0 flex-1 truncate">
              {props.scopedProjectGroup?.displayName ?? "All projects"}
            </span>
            <ChevronDownIcon className="-mr-px size-4 shrink-0" />
          </MenuTrigger>
          <MenuPopup align="start" anchor={rowRef} className="w-(--anchor-width)">
            <MenuRadioGroup
              value={props.projectScopeKey ?? "all"}
              onValueChange={(value) =>
                props.onProjectScopeChange(value === "all" ? null : (value as string))
              }
            >
              <MenuRadioItem value="all" closeOnClick className={MENU_ITEM}>
                <FolderIcon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm">All projects</span>
              </MenuRadioItem>
              {props.projectGroups.map((project) => (
                <MenuRadioItem
                  key={project.projectKey}
                  value={project.projectKey}
                  closeOnClick
                  className={MENU_ITEM}
                >
                  <ProjectFavicon
                    environmentId={project.environmentId}
                    cwd={project.workspaceRoot}
                    faviconPath={project.faviconPath}
                    className="size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{project.displayName}</span>
                  <button
                    type="button"
                    aria-label={`Project settings for ${project.displayName}`}
                    title={`Project settings for ${project.displayName}`}
                    className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-icon-muted outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => props.onProjectSettings(event, project)}
                  >
                    <SettingsIcon className="size-3.5" />
                  </button>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem className={MENU_ITEM} onClick={props.onNewProject}>
              <FolderPlusIcon className="size-4 shrink-0" />
              <span className="min-w-0 truncate text-sm">New project…</span>
            </MenuItem>
          </MenuPopup>
        </Menu>
        {/* Segmented well: the pair reads as one control instead of two loose
          buttons competing with the selector beside them. */}
        <div className="flex shrink-0 items-center rounded-md bg-sidebar-control-surface/60 p-px ring-1 ring-sidebar-border/50">
          <HeaderIconButton
            label={searchOpen ? "Hide search" : "Search threads"}
            className="size-7"
            isActive={searchOpen}
            aria-expanded={searchOpen}
            aria-controls={searchOpen ? SEARCH_ROW_ID : undefined}
            onClick={toggleSearch}
          >
            <SearchIcon />
          </HeaderIconButton>
          <HeaderIconButton
            label={
              props.newThreadShortcutLabel
                ? `New thread (${props.newThreadShortcutLabel})`
                : "New thread"
            }
            className="size-7"
            disabled={props.newThreadDisabled}
            onClick={props.onNewThread}
          >
            <SquarePenIcon />
          </HeaderIconButton>
        </div>
      </div>
      {searchOpen ? <SearchRow props={props} onClose={closeSearch} /> : null}
    </>
  );
}

/**
 * Sits under the scope row in normal flow, so opening it pushes the thread list
 * down rather than covering it.
 */
function SearchRow({ props, onClose }: { props: SidebarThreadHeaderProps; onClose: () => void }) {
  const resultsVisible = props.isSearching && props.searchResultCount > 0;
  // Results shrink as the query narrows, so the active index can outrun the
  // list; pointing aria-activedescendant at a removed option strands the
  // screen reader on nothing.
  const activeResultExists =
    resultsVisible && props.activeSearchResultIndex < props.searchResultCount;
  return (
    <div
      id={SEARCH_ROW_ID}
      className="flex h-8 min-w-0 items-center gap-2 rounded-md bg-sidebar-control-surface/60 px-2 py-1.5 text-sm font-medium ring-1 ring-sidebar-border/50 focus-within:ring-ring"
    >
      <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
      <Input
        ref={props.searchInputRef}
        nativeInput
        unstyled
        type="search"
        value={props.searchQuery}
        onChange={(event) => props.onSearchQueryChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          // Escape clears first and closes second: one press to drop the query
          // without losing the field, another to leave search entirely.
          if (
            event.key === "Escape" &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229 &&
            props.searchQuery.trim().length === 0
          ) {
            event.preventDefault();
            onClose();
            return;
          }
          props.onSearchKeyDown(event);
        }}
        placeholder={`Search ${props.scopedProjectGroup?.displayName ?? "all projects"}`}
        aria-label="Search threads"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={resultsVisible}
        aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
        aria-activedescendant={
          activeResultExists
            ? `sidebar-thread-search-result-${props.activeSearchResultIndex}`
            : undefined
        }
        className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:placeholder:text-sidebar-muted-foreground"
      />
      {/* Clears without closing — the toggle above is what leaves search. */}
      {props.isSearching ? (
        <button
          type="button"
          aria-label="Clear thread search"
          onClick={() => {
            props.onClearSearch();
            props.searchInputRef.current?.focus();
          }}
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-sidebar-muted-foreground outline-none hover:bg-sidebar-control-surface hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function ScopeIcon({ group }: { group: SidebarProjectSnapshot | null }) {
  return group ? (
    <ProjectFavicon
      environmentId={group.environmentId}
      cwd={group.workspaceRoot}
      faviconPath={group.faviconPath}
      className="size-4 shrink-0"
    />
  ) : (
    <FolderIcon className="size-4 shrink-0" />
  );
}

function HeaderIconButton({
  label,
  onClick,
  disabled,
  className,
  isActive,
  children,
  ...ariaProps
}: {
  label: string;
  onClick: (event: ReactMouseEvent) => void;
  disabled?: boolean | undefined;
  className?: string | undefined;
  isActive?: boolean | undefined;
  "aria-expanded"?: boolean | undefined;
  "aria-controls"?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            disabled={disabled}
            {...(isActive === undefined ? {} : { isActive })}
            onClick={onClick}
            {...ariaProps}
            className={cn(
              "relative shrink-0 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
              className,
            )}
          />
        }
      >
        {children}
        {/* Coarse-pointer hit area, matching the rest of the sidebar chrome. */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
