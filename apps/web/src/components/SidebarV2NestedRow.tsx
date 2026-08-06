import { ArchiveIcon, ChevronRightIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import type { ProviderInstanceEntry } from "../providerInstances";
import type { SidebarThreadSummary } from "../types";
import { cn } from "~/lib/utils";
import { getSidebarThreadPrewarmKey } from "./SidebarThreadPrewarmer";
import { resolveTerminalThreadRef, ThreadBrowserOpenStatus } from "./ThreadStatusIndicators";
import { ThreadDetailsTooltip, useThreadEnvironmentLabel } from "./SidebarV2ThreadTooltip";
import { Button } from "./ui/button";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";
import { Tooltip, TooltipTrigger } from "./ui/tooltip";

// Nesting reads from indentation alone, and past a few levels the extra offset
// costs more title width than the hierarchy it conveys.
const MAX_NESTED_INDENT_DEPTH = 3;
const NESTED_INDENT_PX = 14;

export interface SidebarV2NestedRowProps {
  readonly thread: SidebarThreadSummary;
  readonly projectName: string;
  readonly projectCwd: string | null;
  readonly providerEntry: ProviderInstanceEntry | null;
  readonly depth: number;
  readonly active: boolean;
  readonly hasChildren: boolean;
  readonly isExpanded: boolean;
  readonly childCount: number;
  /** Self or any active descendant is mid-turn; archive would hide that work. */
  readonly archiveBlocked: boolean;
  readonly onOpen: (thread: SidebarThreadSummary) => void;
  readonly onToggleExpanded: (thread: SidebarThreadSummary, isExpanded: boolean) => void;
  readonly onArchive: (thread: SidebarThreadSummary) => void;
  readonly onDismissAgentRun: (thread: SidebarThreadSummary) => void;
}

/**
 * A nested chat's row: title only. Project, status, timestamp and git metadata
 * all belong to the parent card, and repeating them here would bury the one
 * thing a nested chat is identified by. Deliberately does not subscribe to git
 * status either — a nested chat inherits its parent's worktree, so the query
 * would be pure cost.
 */
export const SidebarV2NestedRow = memo(function SidebarV2NestedRow({
  thread,
  projectName,
  projectCwd,
  providerEntry,
  depth,
  active,
  hasChildren,
  isExpanded,
  childCount,
  archiveBlocked,
  onOpen,
  onToggleExpanded,
  onArchive,
  onDismissAgentRun,
}: SidebarV2NestedRowProps) {
  const { environmentLabel } = useThreadEnvironmentLabel(thread);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, resolveTerminalThreadRef(thread))
        .runningTerminalIds,
  );

  const agentRun = thread.virtualAgentRun;

  const handleOpen = useCallback(() => onOpen(thread), [onOpen, thread]);
  const handleArchive = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (archiveBlocked) return;
      if (agentRun) {
        onDismissAgentRun(thread);
      } else {
        onArchive(thread);
      }
    },
    [agentRun, archiveBlocked, onArchive, onDismissAgentRun, thread],
  );
  const handleToggleExpanded = useCallback(
    (event: React.SyntheticEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onToggleExpanded(thread, isExpanded);
    },
    [isExpanded, onToggleExpanded, thread],
  );
  const handleToggleExpandedPointerDown = useCallback((event: React.PointerEvent) => {
    event.stopPropagation();
  }, []);
  // The row surface is a role="button" div rather than a native <button> so the
  // chevron can live inside it as its own control; that costs native keyboard
  // activation, which is restored here for the row's own key events only.
  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onOpen(thread);
    },
    [onOpen, thread],
  );

  return (
    <SidebarMenuItem
      className="group/thread relative"
      data-thread-prewarm-key={getSidebarThreadPrewarmKey(thread)}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              className="h-auto min-h-0 gap-1 px-2.5 py-[calc(var(--app-sidebar-row-padding-y)*0.6)] text-[length:var(--app-sidebar-font-size)] transition-none"
              isActive={active}
              onClick={handleOpen}
              onKeyDown={handleRowKeyDown}
              render={<div role="button" tabIndex={0} />}
              style={{
                paddingLeft: Math.min(depth, MAX_NESTED_INDENT_DEPTH) * NESTED_INDENT_PX + 10,
              }}
            />
          }
        >
          {hasChildren ? (
            <button
              aria-expanded={isExpanded}
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${thread.title}`}
              className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/60 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              onClick={handleToggleExpanded}
              onPointerDown={handleToggleExpandedPointerDown}
              title={`${isExpanded ? "Collapse" : "Expand"} ${childCount} nested chat${
                childCount === 1 ? "" : "s"
              }`}
              type="button"
            >
              <ChevronRightIcon
                className={cn(
                  "size-3 transition-transform duration-150",
                  isExpanded && "rotate-90",
                )}
              />
            </button>
          ) : (
            <span aria-hidden="true" className="inline-block size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate text-[length:var(--app-sidebar-title-font-size)] text-foreground/85">
            {thread.title}
          </span>
          <ThreadBrowserOpenStatus environmentId={thread.environmentId} threadId={thread.id} />
        </TooltipTrigger>
        <ThreadDetailsTooltip
          environmentLabel={environmentLabel}
          projectCwd={projectCwd}
          projectName={projectName}
          providerEntry={providerEntry}
          terminalProcessCount={runningTerminalIds.length}
          thread={thread}
        />
      </Tooltip>
      <div className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 items-center group-hover/thread:flex group-focus-within/thread:flex [&>button]:transition-none">
        <Button
          aria-label={`Archive ${thread.title}`}
          disabled={archiveBlocked}
          onClick={handleArchive}
          size="icon-xs"
          title={
            archiveBlocked
              ? "Cannot archive while this chat or a nested chat is running"
              : "Archive"
          }
          variant="ghost"
        >
          <ArchiveIcon />
        </Button>
      </div>
    </SidebarMenuItem>
  );
});
