import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { selectHasBoardFilters, useBoardStore } from "../../boardStore";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";

export interface BoardToolbarOption {
  readonly id: string;
  readonly label: string;
}

export function BoardToolbar(props: {
  readonly projectOptions: ReadonlyArray<BoardToolbarOption>;
  readonly providerOptions: ReadonlyArray<BoardToolbarOption>;
  readonly visibleCount: number;
  readonly onNewThread: () => void;
}) {
  const projectScopeKey = useBoardStore((state) => state.projectScopeKey);
  const providerScopeId = useBoardStore((state) => state.providerScopeId);
  const searchQuery = useBoardStore((state) => state.searchQuery);
  const setProjectScopeKey = useBoardStore((state) => state.setProjectScopeKey);
  const setProviderScopeId = useBoardStore((state) => state.setProviderScopeId);
  const setSearchQuery = useBoardStore((state) => state.setSearchQuery);
  const clearFilters = useBoardStore((state) => state.clearFilters);
  const hasFilters = useBoardStore(selectHasBoardFilters);

  const projectLabel =
    props.projectOptions.find((option) => option.id === projectScopeKey)?.label ?? "All projects";
  const providerLabel =
    props.providerOptions.find((option) => option.id === providerScopeId)?.label ?? "All providers";

  return (
    <header
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      <h1 className="text-sm font-medium text-foreground">Board</h1>
      <span className="text-[11px] text-muted-foreground/60 tabular-nums">
        {props.visibleCount} {props.visibleCount === 1 ? "thread" : "threads"}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Filter by title"
          aria-label="Filter threads by title"
          className="h-7 w-40 rounded-md border border-border/60 bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-1 focus-visible:outline-ring"
        />

        <Menu>
          <MenuTrigger render={<Button size="sm" variant="ghost" className="h-7 text-xs" />}>
            {projectLabel}
          </MenuTrigger>
          <MenuPopup align="end" className="max-h-80 w-56 overflow-y-auto">
            <MenuItem onClick={() => setProjectScopeKey(null)}>All projects</MenuItem>
            {props.projectOptions.map((option) => (
              <MenuItem key={option.id} onClick={() => setProjectScopeKey(option.id)}>
                {option.label}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>

        <Menu>
          <MenuTrigger render={<Button size="sm" variant="ghost" className="h-7 text-xs" />}>
            {providerLabel}
          </MenuTrigger>
          <MenuPopup align="end" className="max-h-80 w-56 overflow-y-auto">
            <MenuItem onClick={() => setProviderScopeId(null)}>All providers</MenuItem>
            {props.providerOptions.map((option) => (
              <MenuItem key={option.id} onClick={() => setProviderScopeId(option.id)}>
                {option.label}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>

        {hasFilters ? (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={clearFilters}>
            <XIcon className="size-3.5" />
            Clear
          </Button>
        ) : null}

        <Button size="sm" className="h-7 text-xs" onClick={props.onNewThread}>
          <PlusIcon className="size-3.5" />
          New thread
        </Button>
      </div>
    </header>
  );
}
