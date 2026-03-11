import type { ProjectId, ThreadId, WorktreeId } from "@repo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  ExternalLinkIcon,
  FolderTreeIcon,
  ListTreeIcon,
  LoaderIcon,
  PanelRightCloseIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useTheme } from "../hooks/useTheme";
import { formatRelativeTime } from "../lib/relativeTime";
import { projectListEntriesQueryOptions } from "../lib/projectReactQuery";
import { sendWorktreeThreadPrompt } from "../lib/sendWorktreeThreadPrompt";
import {
  buildWorktreeExplorerList,
  buildWorktreeExplorerTree,
  collectWorktreeExplorerDirectoryPaths,
  flattenWorktreeExplorerTree,
  type WorktreeExplorerEntry,
  type WorktreeExplorerRow,
  type WorktreeExplorerStat,
} from "../lib/worktreeExplorer";
import { gitStatusQueryOptions, invalidateGitQueries } from "../lib/gitReactQuery";
import {
  gitUpdatePullRequestMutationOptions,
  worktreeChecksAddTodoMutationOptions,
  worktreeChecksDeleteTodoMutationOptions,
  worktreeChecksQueryOptions,
  worktreeChecksUpdateTodoMutationOptions,
} from "../lib/worktreeChecksReactQuery";
import { readNativeApi } from "../nativeApi";
import { cn } from "../lib/utils";
import { type WorktreeRightRailState, type WorktreeRightRailTab } from "../worktreeChatLayoutStore";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";
import VscodeEntryIcon from "./VscodeEntryIcon";

const ROW_HEIGHT = 28;

interface WorktreeRightRailProps {
  worktreeId: WorktreeId;
  cwd: string | null;
  projectId: ProjectId | null;
  projectModel: string | null;
  focusedThreadId: ThreadId | null;
  focusedThreadIsServer: boolean;
  railState: WorktreeRightRailState;
  setRailState: (
    updater:
      | Partial<WorktreeRightRailState>
      | ((current: WorktreeRightRailState) => Partial<WorktreeRightRailState>),
  ) => void;
  onClose: () => void;
}

function renderExplorerStat(stat: WorktreeExplorerStat | null | undefined) {
  if (!stat) return null;
  if (stat.insertions === 0 && stat.deletions === 0) return null;
  return (
    <span className="shrink-0 font-mono text-[11px]">
      {stat.insertions > 0 ? <span className="text-success">+{stat.insertions}</span> : null}
      {stat.insertions > 0 && stat.deletions > 0 ? (
        <span className="px-1 text-muted-foreground" aria-hidden="true">
          {" "}
        </span>
      ) : null}
      {stat.deletions > 0 ? <span className="text-destructive">-{stat.deletions}</span> : null}
    </span>
  );
}

function renderCheckStatusIcon(state: string) {
  switch (state) {
    case "failure":
      return <XIcon className="size-3.5 shrink-0 text-destructive" />;
    case "success":
      return <CheckIcon className="size-3.5 shrink-0 text-success" />;
    case "pending":
    case "in_progress":
      return <CircleIcon className="size-3 shrink-0 fill-current text-warning" />;
    default:
      return <CircleIcon className="size-3 shrink-0 fill-current text-muted-foreground" />;
  }
}

function formatRuntime(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function renderTreeRowLabel(row: WorktreeExplorerRow, depth: number, theme: "light" | "dark") {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="shrink-0" style={{ width: `${depth * 14}px` }} />
      {row.kind === "directory" ? (
        row.expandable ? (
          row.expanded ? (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          )
        ) : (
          <span className="inline-block size-3.5 shrink-0" />
        )
      ) : null}
      <VscodeEntryIcon pathValue={row.path} kind={row.kind} theme={theme} />
      <span className="truncate">{row.name}</span>
    </div>
  );
}

function ExplorerList(props: {
  rows: WorktreeExplorerRow[];
  theme: "light" | "dark";
  onToggleDirectory: (path: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: props.rows.length,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => props.rows[index]?.path ?? index,
    estimateSize: () => ROW_HEIGHT,
    useAnimationFrameWithResizeObserver: true,
    overscan: 10,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    rowVirtualizer.measure();
    const scrollElement = parentRef.current;
    if (!scrollElement) {
      return;
    }
    const maxScrollOffset = Math.max(0, rowVirtualizer.getTotalSize() - scrollElement.clientHeight);
    if (scrollElement.scrollTop > maxScrollOffset) {
      scrollElement.scrollTop = maxScrollOffset;
    }
  }, [props.rows, rowVirtualizer]);

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
      <div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {virtualRows.map((virtualRow) => {
          const row = props.rows[virtualRow.index];
          if (!row) return null;
          const statLabel = renderExplorerStat(row.stat);
          const rowContent = (
            <div
              className={cn(
                "flex h-7 items-center justify-between gap-2 rounded-md px-2 text-sm",
                row.kind === "directory"
                  ? "cursor-pointer hover:bg-accent/50"
                  : "text-foreground/90 hover:bg-accent/30",
              )}
            >
              {renderTreeRowLabel(row, row.depth, props.theme)}
              {statLabel}
            </div>
          );

          return row.kind === "directory" ? (
            <button
              key={row.path}
              type="button"
              data-index={virtualRow.index}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
              onClick={() => props.onToggleDirectory(row.path)}
            >
              {rowContent}
            </button>
          ) : (
            <div
              key={row.path}
              data-index={virtualRow.index}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {rowContent}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExplorerLoadingState(props: { description: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
      <div className="mb-4 flex items-center text-sm text-muted-foreground">
        <LoaderIcon className="mr-2 size-4 animate-spin" />
        {props.description}
      </div>
      <div className="space-y-2">
        <Skeleton className="h-7 w-[78%] rounded-md" />
        <Skeleton className="h-7 w-[92%] rounded-md" />
        <Skeleton className="h-7 w-[70%] rounded-md" />
        <Skeleton className="h-7 w-[84%] rounded-md" />
        <Skeleton className="h-7 w-[66%] rounded-md" />
        <Skeleton className="h-7 w-[88%] rounded-md" />
      </div>
    </div>
  );
}

function ChangesActions(props: {
  gitStatus: {
    hasMergeConflicts: boolean;
    hasWorkingTreeChanges: boolean;
    aheadCount: number;
    behindCount: number;
  };
  onSendPrompt: (prompt: string) => void;
  isSending: boolean;
}) {
  let ctaLabel: string | null = null;
  if (props.gitStatus.hasMergeConflicts) {
    ctaLabel = "Fix merge conflicts";
  } else if (props.gitStatus.behindCount > 0) {
    ctaLabel = "Pull in changes";
  } else if (props.gitStatus.hasWorkingTreeChanges || props.gitStatus.aheadCount > 0) {
    ctaLabel = "Commit and push";
  }

  if (!ctaLabel) {
    return null;
  }

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={props.isSending}
      onClick={() => props.onSendPrompt(ctaLabel)}
    >
      {props.isSending ? <LoaderIcon className="mr-1.5 size-3 animate-spin" /> : null}
      {ctaLabel}
    </Button>
  );
}

export default function WorktreeRightRail({
  worktreeId,
  cwd,
  projectId,
  projectModel,
  focusedThreadId,
  focusedThreadIsServer,
  railState,
  setRailState,
  onClose,
}: WorktreeRightRailProps) {
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const draftThread = useComposerDraftStore((state) =>
    focusedThreadId ? (state.draftThreadsByThreadId[focusedThreadId] ?? null) : null,
  );
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [newTodoText, setNewTodoText] = useState("");
  const [editingPrTitle, setEditingPrTitle] = useState("");
  const [editingPrBody, setEditingPrBody] = useState("");

  const allFilesQuery = useQuery(projectListEntriesQueryOptions({ cwd, enabled: cwd !== null }));
  const gitStatusQuery = useQuery(gitStatusQueryOptions(cwd));
  const checksQuery = useQuery(
    worktreeChecksQueryOptions({
      cwd,
      worktreeId,
      enabled: cwd !== null,
    }),
  );

  const savePrMutation = useMutation(
    gitUpdatePullRequestMutationOptions({
      cwd,
      queryClient,
    }),
  );
  const addTodoMutation = useMutation(
    worktreeChecksAddTodoMutationOptions({
      worktreeId,
      cwd,
      queryClient,
    }),
  );
  const updateTodoMutation = useMutation(
    worktreeChecksUpdateTodoMutationOptions({
      worktreeId,
      queryClient,
    }),
  );
  const deleteTodoMutation = useMutation(
    worktreeChecksDeleteTodoMutationOptions({
      worktreeId,
      queryClient,
    }),
  );

  const allFilesEntries = useMemo<WorktreeExplorerEntry[]>(
    () =>
      (allFilesQuery.data?.entries ?? []).map((entry) => ({ path: entry.path, kind: entry.kind })),
    [allFilesQuery.data?.entries],
  );
  const changesEntries = useMemo<WorktreeExplorerEntry[]>(
    () =>
      (gitStatusQuery.data?.workingTree.files ?? []).map((file) => ({
        path: file.path,
        kind: "file" as const,
        stat: {
          insertions: file.insertions,
          deletions: file.deletions,
        },
      })),
    [gitStatusQuery.data?.workingTree.files],
  );

  const allFilesTree = useMemo(() => buildWorktreeExplorerTree(allFilesEntries), [allFilesEntries]);
  const changesTree = useMemo(() => buildWorktreeExplorerTree(changesEntries), [changesEntries]);

  const effectiveAllFilesExpandedPaths = useMemo(
    () => new Set(railState.allFilesExpandedPaths ?? []),
    [railState.allFilesExpandedPaths],
  );
  const effectiveChangesExpandedPaths = useMemo(
    () =>
      new Set(railState.changesExpandedPaths ?? collectWorktreeExplorerDirectoryPaths(changesTree)),
    [changesTree, railState.changesExpandedPaths],
  );

  const allFilesRows = useMemo(
    () =>
      railState.allFilesViewMode === "tree"
        ? flattenWorktreeExplorerTree({
            nodes: allFilesTree,
            expandedPaths: effectiveAllFilesExpandedPaths,
          })
        : buildWorktreeExplorerList(allFilesEntries),
    [allFilesEntries, allFilesTree, effectiveAllFilesExpandedPaths, railState.allFilesViewMode],
  );
  const changesRows = useMemo(
    () =>
      railState.changesViewMode === "tree"
        ? flattenWorktreeExplorerTree({
            nodes: changesTree,
            expandedPaths: effectiveChangesExpandedPaths,
          })
        : buildWorktreeExplorerList(changesEntries),
    [changesEntries, changesTree, effectiveChangesExpandedPaths, railState.changesViewMode],
  );
  const checksData = checksQuery.data;
  const currentPullRequest = checksData?.pr ?? null;

  useEffect(() => {
    if (!currentPullRequest) {
      setEditingPrTitle("");
      setEditingPrBody("");
      return;
    }
    setEditingPrTitle(currentPullRequest.title);
    setEditingPrBody(currentPullRequest.body);
  }, [currentPullRequest]);

  const onToggleDirectory = (tab: "all-files" | "changes", path: string) => {
    setRailState((current) => {
      const key = tab === "all-files" ? "allFilesExpandedPaths" : "changesExpandedPaths";
      const defaultPaths =
        tab === "all-files"
          ? (current.allFilesExpandedPaths ?? [])
          : (current.changesExpandedPaths ?? []);
      const next = new Set(defaultPaths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { [key]: [...next] } as Partial<WorktreeRightRailState>;
    });
  };

  const openExternalUrl = async (url: string | null) => {
    if (!url) return;
    const api = readNativeApi();
    if (!api) return;
    await api.shell.openExternal(url);
  };

  const sendPrompt = async (prompt: string) => {
    if (!focusedThreadId || !projectId || !projectModel) {
      toastManager.add({
        type: "warning",
        title: "No active thread",
        description: "Open or create a worktree thread first.",
      });
      return;
    }

    setPendingPrompt(prompt);
    try {
      await sendWorktreeThreadPrompt({
        targetThreadId: focusedThreadId,
        worktreeId,
        projectId,
        projectModel,
        prompt,
        isServerThread: focusedThreadIsServer,
        draftThread,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not send prompt",
        description: error instanceof Error ? error.message : "An unknown error occurred.",
      });
    } finally {
      setPendingPrompt(null);
    }
  };

  const activeTab: WorktreeRightRailTab = railState.activeTab;
  const activeExplorerViewMode =
    activeTab === "all-files" ? railState.allFilesViewMode : railState.changesViewMode;
  const explorerListKey = `${activeTab}:${activeExplorerViewMode}`;
  const showChecksTodos = false;
  const isAllFilesLoading =
    activeTab === "all-files" &&
    (allFilesQuery.isPending ||
      (allFilesQuery.isFetching &&
        allFilesQuery.isPlaceholderData &&
        allFilesEntries.length === 0));
  const isChangesLoading = activeTab === "changes" && gitStatusQuery.isLoading;
  const isExplorerLoading = isAllFilesLoading || isChangesLoading;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col border-l border-border/70 bg-card/50">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/60 px-2">
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            className={cn(
              "rounded-md px-2 py-1 text-sm transition-colors",
              activeTab === "all-files"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setRailState({ activeTab: "all-files" })}
          >
            All files
          </button>
          <button
            type="button"
            className={cn(
              "rounded-md px-2 py-1 text-sm transition-colors",
              activeTab === "changes"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setRailState({ activeTab: "changes" })}
          >
            Changes {changesEntries.length > 0 ? changesEntries.length : ""}
          </button>
          <button
            type="button"
            className={cn(
              "rounded-md px-2 py-1 text-sm transition-colors",
              activeTab === "checks"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setRailState({ activeTab: "checks" })}
          >
            Checks
          </button>
        </div>
        <div className="flex items-center gap-0.5">
          {activeTab !== "checks" ? (
            <Fragment>
              <button
                type="button"
                aria-label="Tree view"
                title="Tree view"
                className={cn(
                  "inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground",
                  activeExplorerViewMode === "tree"
                    ? "bg-accent text-foreground"
                    : "bg-transparent",
                )}
                onClick={() => {
                  if (activeTab === "all-files") {
                    setRailState({ allFilesViewMode: "tree" });
                  } else {
                    setRailState({ changesViewMode: "tree" });
                  }
                }}
              >
                <FolderTreeIcon className="size-3" />
              </button>
              <button
                type="button"
                aria-label="List view"
                title="List view"
                className={cn(
                  "inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground",
                  activeExplorerViewMode === "list"
                    ? "bg-accent text-foreground"
                    : "bg-transparent",
                )}
                onClick={() => {
                  if (activeTab === "all-files") {
                    setRailState({ allFilesViewMode: "list" });
                  } else {
                    setRailState({ changesViewMode: "list" });
                  }
                }}
              >
                <ListTreeIcon className="size-3" />
              </button>
            </Fragment>
          ) : null}
          <Button size="icon-xs" variant="ghost" aria-label="Close right rail" onClick={onClose}>
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {activeTab !== "checks" ? (
        <Fragment>
          {isExplorerLoading ? (
            <ExplorerLoadingState
              description={
                activeTab === "all-files" ? "Loading workspace files…" : "Loading changes…"
              }
            />
          ) : activeTab === "all-files" ? (
            allFilesRows.length > 0 ? (
              <ExplorerList
                key={explorerListKey}
                rows={allFilesRows}
                theme={theme}
                onToggleDirectory={(path) => onToggleDirectory("all-files", path)}
              />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
                No indexed files.
              </div>
            )
          ) : changesRows.length > 0 ? (
            <ExplorerList
              key={explorerListKey}
              rows={changesRows}
              theme={theme}
              onToggleDirectory={(path) => onToggleDirectory("changes", path)}
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
              Working tree is clean.
            </div>
          )}
          {(activeTab === "all-files" ? allFilesQuery.data?.truncated : false) ? (
            <div className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
              Results truncated to the indexed workspace limit.
            </div>
          ) : null}
        </Fragment>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
          {checksQuery.isLoading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <LoaderIcon className="mr-2 size-4 animate-spin" />
              Loading checks…
            </div>
          ) : (
            <div className="space-y-5">
              {currentPullRequest ? (
                <div className="space-y-2">
                  <Input
                    value={editingPrTitle}
                    onChange={(event) => setEditingPrTitle(event.target.value)}
                    className="h-8 bg-background"
                  />
                  <Textarea
                    value={editingPrBody}
                    onChange={(event) => setEditingPrBody(event.target.value)}
                    rows={5}
                    className="bg-background text-sm **:[textarea]:max-h-56 **:[textarea]:overflow-y-auto **:[textarea]:resize-none"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        savePrMutation.isPending ||
                        editingPrTitle.trim().length === 0 ||
                        (editingPrTitle === currentPullRequest.title &&
                          editingPrBody === currentPullRequest.body)
                      }
                      onClick={() => {
                        const pullRequest = currentPullRequest;
                        if (!pullRequest) {
                          return;
                        }
                        void savePrMutation
                          .mutateAsync({
                            number: pullRequest.number,
                            title: editingPrTitle.trim(),
                            body: editingPrBody,
                          })
                          .then(() => {
                            toastManager.add({ type: "success", title: "Pull request updated" });
                            void invalidateGitQueries(queryClient);
                          })
                          .catch((error) => {
                            toastManager.add({
                              type: "error",
                              title: "Could not update pull request",
                              description:
                                error instanceof Error
                                  ? error.message
                                  : "An unknown error occurred.",
                            });
                          });
                      }}
                    >
                      {savePrMutation.isPending ? (
                        <LoaderIcon className="mr-1.5 size-3 animate-spin" />
                      ) : (
                        <SaveIcon className="mr-1.5 size-3" />
                      )}
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        void openExternalUrl(currentPullRequest?.url ?? null);
                      }}
                    >
                      PR
                      <ExternalLinkIcon className="ml-1.5 size-3" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-border/60 bg-background/40 p-3 text-sm text-muted-foreground">
                  No open pull request for this worktree.
                </div>
              )}

              {checksData?.githubUnavailableReason ? (
                <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">
                  {checksData.githubUnavailableReason}
                </div>
              ) : null}

              {checksData ? (
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">Git status</h3>
                    <ChangesActions
                      gitStatus={checksData.gitStatus}
                      isSending={pendingPrompt !== null}
                      onSendPrompt={(prompt) => {
                        void sendPrompt(prompt);
                      }}
                    />
                  </div>
                  <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-sm">
                    {checksData.gitStatus.hasMergeConflicts ? (
                      <p>
                        {checksData.gitStatus.workingTree.files.length} conflicted or modified files
                      </p>
                    ) : checksData.gitStatus.hasWorkingTreeChanges ? (
                      <p>{checksData.gitStatus.workingTree.files.length} uncommitted changes</p>
                    ) : checksData.gitStatus.aheadCount > 0 ? (
                      <p>{checksData.gitStatus.aheadCount} unpushed commit(s)</p>
                    ) : checksData.gitStatus.behindCount > 0 ? (
                      <p>Behind upstream by {checksData.gitStatus.behindCount} commit(s)</p>
                    ) : (
                      <p>Worktree is up to date.</p>
                    )}
                  </div>
                </section>
              ) : null}

              <section className="space-y-2">
                <h3 className="text-sm font-medium">Deployments</h3>
                {checksData?.deployments.length ? (
                  <div className="space-y-1">
                    {checksData.deployments.map((deployment) => (
                      <button
                        type="button"
                        key={deployment.id}
                        className={cn(
                          "flex w-full min-w-0 items-center justify-between gap-3 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-accent/25",
                          (deployment.previewUrl ?? deployment.detailsUrl) ? "cursor-pointer" : "",
                        )}
                        onClick={() => {
                          void openExternalUrl(deployment.previewUrl ?? deployment.detailsUrl);
                        }}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {renderCheckStatusIcon(deployment.state)}
                          <span className="truncate text-foreground/90">{deployment.name}</span>
                        </span>
                        {(deployment.previewUrl ?? deployment.detailsUrl) ? (
                          <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No deployments found.</p>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-medium">Checks</h3>
                {checksData?.checks.length ? (
                  <div className="space-y-1">
                    {checksData.checks.map((check) => (
                      <button
                        type="button"
                        key={check.id}
                        className={cn(
                          "flex w-full min-w-0 items-center justify-between gap-3 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-accent/25",
                          check.linkUrl ? "cursor-pointer" : "",
                        )}
                        onClick={() => {
                          void openExternalUrl(check.linkUrl);
                        }}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {renderCheckStatusIcon(check.state)}
                          <span className="truncate text-foreground/90">{check.label}</span>
                          {formatRuntime(check.runtimeSeconds) ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {formatRuntime(check.runtimeSeconds)}
                            </span>
                          ) : null}
                        </span>
                        {check.linkUrl ? (
                          <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No checks found.</p>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-medium">Comments</h3>
                {checksData?.comments.length ? (
                  <div className="space-y-2">
                    {checksData.comments.map((comment) => (
                      <button
                        type="button"
                        key={comment.id}
                        className={cn(
                          "w-full min-w-0 overflow-hidden rounded-md border border-border/50 bg-background/40 px-3 py-2 text-left transition-colors hover:bg-accent/40",
                          comment.url ? "cursor-pointer" : "",
                        )}
                        onClick={() => {
                          void openExternalUrl(comment.url);
                        }}
                      >
                        <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
                          <span className="min-w-0 flex-1 truncate">{comment.author}</span>
                          <span className="shrink-0">{formatRelativeTime(comment.createdAt)}</span>
                        </div>
                        <p className="mt-1 min-w-0 whitespace-pre-wrap break-words text-sm">
                          {comment.bodyPreview || "Open comment"}
                        </p>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No comments yet.</p>
                )}
              </section>

              {/* Hiding the todos section for now until the Checks tab UX is finalized. */}
              {showChecksTodos ? (
                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">Todos</h3>
                    <div className="flex items-center gap-2">
                      <Input
                        value={newTodoText}
                        onChange={(event) => setNewTodoText(event.target.value)}
                        placeholder="Add todo"
                        className="h-8 w-40 bg-background"
                      />
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        disabled={addTodoMutation.isPending || newTodoText.trim().length === 0}
                        onClick={() => {
                          const text = newTodoText.trim();
                          if (text.length === 0) return;
                          void addTodoMutation
                            .mutateAsync(text)
                            .then(() => setNewTodoText(""))
                            .catch((error) => {
                              toastManager.add({
                                type: "error",
                                title: "Could not add todo",
                                description:
                                  error instanceof Error
                                    ? error.message
                                    : "An unknown error occurred.",
                              });
                            });
                        }}
                      >
                        {addTodoMutation.isPending ? (
                          <LoaderIcon className="size-3 animate-spin" />
                        ) : (
                          <PlusIcon className="size-3" />
                        )}
                      </Button>
                    </div>
                  </div>
                  {checksData?.todos.length ? (
                    <div className="space-y-1">
                      {checksData.todos.map((todo) => (
                        <div
                          key={todo.todoId}
                          className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/40 px-3 py-2"
                        >
                          <label className="flex min-w-0 items-center gap-2 text-sm">
                            <Checkbox
                              checked={todo.completed}
                              onCheckedChange={(checked) => {
                                void updateTodoMutation
                                  .mutateAsync({
                                    todoId: todo.todoId,
                                    completed: checked === true,
                                  })
                                  .catch((error) => {
                                    toastManager.add({
                                      type: "error",
                                      title: "Could not update todo",
                                      description:
                                        error instanceof Error
                                          ? error.message
                                          : "An unknown error occurred.",
                                    });
                                  });
                              }}
                            />
                            <span
                              className={cn(
                                "truncate",
                                todo.completed && "text-muted-foreground line-through",
                              )}
                            >
                              {todo.text}
                            </span>
                          </label>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Delete ${todo.text}`}
                            onClick={() => {
                              void deleteTodoMutation.mutateAsync(todo.todoId).catch((error) => {
                                toastManager.add({
                                  type: "error",
                                  title: "Could not delete todo",
                                  description:
                                    error instanceof Error
                                      ? error.message
                                      : "An unknown error occurred.",
                                });
                              });
                            }}
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No todos yet.</p>
                  )}
                </section>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
