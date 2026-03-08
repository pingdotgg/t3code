import type * as React from "react";
import { ChevronRightIcon, FolderIcon, GitPullRequestIcon, SquarePenIcon, TerminalIcon } from "lucide-react";
import type { GitStatusResult, ProjectId, ThreadId } from "@t3tools/contracts";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import { type Thread, type Project } from "../types";
import { selectThreadTerminalState, type TerminalStateByThreadId } from "../terminalStateStore";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  THREAD_PREVIEW_LIMIT,
  formatRelativeTime,
  formatRemoteProjectHost,
  prStatusIndicator,
  terminalStatusFromRunningIds,
  threadStatusPill,
} from "./Sidebar.helpers";
import { ProjectFavicon } from "./SidebarProjectFavicon";

interface SidebarProjectTreeProps {
  projects: readonly Project[];
  threads: readonly Thread[];
  expandedThreadListsByProject: ReadonlySet<ProjectId>;
  routeThreadId: ThreadId | null;
  pendingApprovalByThreadId: ReadonlyMap<ThreadId, boolean>;
  prByThreadId: ReadonlyMap<ThreadId, GitStatusResult["pr"]>;
  terminalStateByThreadId: TerminalStateByThreadId;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  renamingInputRef: React.MutableRefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.MutableRefObject<boolean>;
  newThreadShortcutLabel: string | null;
  onToggleProject: (projectId: ProjectId) => void;
  onCreateThread: (
    projectId: ProjectId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
    },
  ) => void;
  onNavigateThread: (threadId: ThreadId) => void;
  onProjectContextMenu: (projectId: ProjectId, position: { x: number; y: number }) => void;
  onThreadContextMenu: (threadId: ThreadId, position: { x: number; y: number }) => void;
  onOpenPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  onExpandThreadList: (projectId: ProjectId) => void;
  onCollapseThreadList: (projectId: ProjectId) => void;
  onRenamingTitleChange: (value: string) => void;
  onCommitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => void;
  onCancelRename: () => void;
}

export function SidebarProjectTree({
  projects,
  threads,
  expandedThreadListsByProject,
  routeThreadId,
  pendingApprovalByThreadId,
  prByThreadId,
  terminalStateByThreadId,
  renamingThreadId,
  renamingTitle,
  renamingInputRef,
  renamingCommittedRef,
  newThreadShortcutLabel,
  onToggleProject,
  onCreateThread,
  onNavigateThread,
  onProjectContextMenu,
  onThreadContextMenu,
  onOpenPrLink,
  onExpandThreadList,
  onCollapseThreadList,
  onRenamingTitleChange,
  onCommitRename,
  onCancelRename,
}: SidebarProjectTreeProps) {
  return (
    <SidebarMenu>
      {projects.map((project) => {
        const projectThreads = threads
          .filter((thread) => thread.projectId === project.id)
          .toSorted((left, right) => {
            const byDate = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
            if (byDate !== 0) return byDate;
            return right.id.localeCompare(left.id);
          });
        const isThreadListExpanded = expandedThreadListsByProject.has(project.id);
        const hasHiddenThreads = projectThreads.length > THREAD_PREVIEW_LIMIT;
        const visibleThreads =
          hasHiddenThreads && !isThreadListExpanded
            ? projectThreads.slice(0, THREAD_PREVIEW_LIMIT)
            : projectThreads;

        return (
          <Collapsible
            key={project.id}
            className="group/collapsible"
            open={project.expanded}
            onOpenChange={(open) => {
              if (open === project.expanded) return;
              onToggleProject(project.id);
            }}
          >
            <SidebarMenuItem>
              <div className="group/project-header relative">
                <CollapsibleTrigger
                  render={
                    <SidebarMenuButton
                      size="sm"
                      className={`gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground ${
                        project.executionTarget === "ssh-remote" ? "h-auto" : ""
                      }`}
                    />
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onProjectContextMenu(project.id, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <ChevronRightIcon
                    className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                      project.expanded ? "rotate-90" : ""
                    }`}
                  />
                  {project.executionTarget === "local" ? (
                    <ProjectFavicon cwd={project.cwd} />
                  ) : (
                    <FolderIcon className="size-3.5 shrink-0 text-sky-500/80" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-foreground/90">
                      {project.name}
                    </div>
                    {project.executionTarget === "ssh-remote" && (
                      <div className="mt-0.5 truncate text-[10px] text-muted-foreground/60">
                        <span className="text-sky-500/80 dark:text-sky-400/70">
                          {formatRemoteProjectHost(project)}
                        </span>
                        <span className="mx-1">·</span>
                        {project.cwd}
                      </div>
                    )}
                  </div>
                </CollapsibleTrigger>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <SidebarMenuAction
                        render={
                          <button
                            type="button"
                            aria-label={`Create new thread in ${project.name}`}
                          />
                        }
                        showOnHover
                        className="top-1 right-1 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onCreateThread(project.id);
                        }}
                      >
                        <SquarePenIcon className="size-3.5" />
                      </SidebarMenuAction>
                    }
                  />
                  <TooltipPopup side="top">
                    {newThreadShortcutLabel
                      ? `New thread (${newThreadShortcutLabel})`
                      : "New thread"}
                  </TooltipPopup>
                </Tooltip>
              </div>

              <CollapsibleContent>
                <SidebarMenuSub className="mx-1 my-0 w-full translate-x-0 gap-0 px-1.5 py-0">
                  {visibleThreads.map((thread) => {
                    const isActive = routeThreadId === thread.id;
                    const threadStatus = threadStatusPill(
                      thread,
                      pendingApprovalByThreadId.get(thread.id) === true,
                    );
                    const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
                    const terminalStatus = terminalStatusFromRunningIds(
                      selectThreadTerminalState(terminalStateByThreadId, thread.id).runningTerminalIds,
                    );

                    return (
                      <SidebarMenuSubItem key={thread.id} className="w-full">
                        <SidebarMenuSubButton
                          render={<div role="button" tabIndex={0} />}
                          size="sm"
                          isActive={isActive}
                          className={`h-7 w-full translate-x-0 cursor-default justify-start px-2 text-left hover:bg-accent hover:text-foreground ${
                            isActive
                              ? "bg-accent/85 text-foreground font-medium ring-1 ring-border/70 dark:bg-accent/55 dark:ring-border/50"
                              : "text-muted-foreground"
                          }`}
                          onClick={() => onNavigateThread(thread.id)}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            onNavigateThread(thread.id);
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            onThreadContextMenu(thread.id, {
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }}
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                            {prStatus && (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <button
                                      type="button"
                                      aria-label={prStatus.tooltip}
                                      className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                                      onClick={(event) => {
                                        onOpenPrLink(event, prStatus.url);
                                      }}
                                    >
                                      <GitPullRequestIcon className="size-3" />
                                    </button>
                                  }
                                />
                                <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
                              </Tooltip>
                            )}
                            {threadStatus && (
                              <span
                                className={`inline-flex items-center gap-1 text-[10px] ${threadStatus.colorClass}`}
                              >
                                <span
                                  className={`h-1.5 w-1.5 rounded-full ${threadStatus.dotClass} ${
                                    threadStatus.pulse ? "animate-pulse" : ""
                                  }`}
                                />
                                <span className="hidden md:inline">{threadStatus.label}</span>
                              </span>
                            )}
                            {renamingThreadId === thread.id ? (
                              <input
                                ref={(element) => {
                                  if (element && renamingInputRef.current !== element) {
                                    renamingInputRef.current = element;
                                    element.focus();
                                    element.select();
                                  }
                                }}
                                className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-xs outline-none"
                                value={renamingTitle}
                                onChange={(event) => onRenamingTitleChange(event.target.value)}
                                onKeyDown={(event) => {
                                  event.stopPropagation();
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    renamingCommittedRef.current = true;
                                    onCommitRename(thread.id, renamingTitle, thread.title);
                                  } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    renamingCommittedRef.current = true;
                                    onCancelRename();
                                  }
                                }}
                                onBlur={() => {
                                  if (!renamingCommittedRef.current) {
                                    onCommitRename(thread.id, renamingTitle, thread.title);
                                  }
                                }}
                                onClick={(event) => event.stopPropagation()}
                              />
                            ) : (
                              <span className="min-w-0 flex-1 truncate text-xs">
                                {thread.title}
                              </span>
                            )}
                          </div>
                          <div className="ml-auto flex shrink-0 items-center gap-1.5">
                            {terminalStatus && (
                              <span
                                role="img"
                                aria-label={terminalStatus.label}
                                title={terminalStatus.label}
                                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
                              >
                                <TerminalIcon
                                  className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`}
                                />
                              </span>
                            )}
                            <span
                              className={`text-[10px] ${
                                isActive ? "text-foreground/65" : "text-muted-foreground/40"
                              }`}
                            >
                              {formatRelativeTime(thread.createdAt)}
                            </span>
                          </div>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    );
                  })}

                  {hasHiddenThreads && !isThreadListExpanded && (
                    <SidebarMenuSubItem className="w-full">
                      <SidebarMenuSubButton
                        render={<button type="button" />}
                        size="sm"
                        className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                        onClick={() => onExpandThreadList(project.id)}
                      >
                        <span>Show more</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  )}
                  {hasHiddenThreads && isThreadListExpanded && (
                    <SidebarMenuSubItem className="w-full">
                      <SidebarMenuSubButton
                        render={<button type="button" />}
                        size="sm"
                        className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                        onClick={() => onCollapseThreadList(project.id)}
                      >
                        <span>Show less</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  )}
                </SidebarMenuSub>
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        );
      })}
    </SidebarMenu>
  );
}
