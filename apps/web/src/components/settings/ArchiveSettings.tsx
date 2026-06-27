import {
  ArchiveIcon,
  ArchiveX,
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  LoaderIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useProjects } from "../../state/entities";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { readLocalApi } from "../../localApi";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  archivedProjectBulkScopeLabel,
  type ArchivedProjectBulkFailure,
  type ArchivedProjectBulkScope,
  type ArchivedProjectBulkThread,
  type ArchivedThreadSortField,
  type ArchivedThreadSortState,
  buildArchivedThreadGroups,
  nextArchivedThreadSortState,
  parseArchivedThreadSearchInput,
  runArchivedProjectThreadActions,
} from "./SettingsPanels.logic";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";

function ArchivedSortButton({
  field,
  label,
  sort,
  onClick,
}: {
  readonly field: ArchivedThreadSortField;
  readonly label: string;
  readonly sort: ArchivedThreadSortState;
  readonly onClick: () => void;
}) {
  const active = sort.field === field;
  const SortIcon = sort.direction === "asc" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <button
      type="button"
      className="inline-flex min-w-0 items-center justify-end gap-1 text-right text-[11px] font-medium text-muted-foreground/70 transition-colors hover:text-foreground"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <span className="truncate">{label}</span>
      {active ? <SortIcon className="size-3 shrink-0" /> : <span className="size-3 shrink-0" />}
    </button>
  );
}

function ArchivedIconButton({
  label,
  destructive = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={destructive ? "destructive-outline" : "ghost"}
            size="icon-xs"
            aria-label={label}
            className="size-6 rounded-md"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useProjects();
  const { unarchiveThread, deleteThread } = useThreadActions();
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [archiveSearchQuery, setArchiveSearchQuery] = useState("");
  const [sort, setSort] = useState<ArchivedThreadSortState>({
    field: "archivedAt",
    direction: "desc",
  });
  useRelativeTimeTick();
  const environmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))],
    [projects],
  );
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(environmentIds);
  const archiveSearch = useMemo(
    () => parseArchivedThreadSearchInput(archiveSearchQuery),
    [archiveSearchQuery],
  );
  const hasArchivedThreads = useMemo(
    () => archivedSnapshots.some(({ snapshot }) => snapshot.threads.length > 0),
    [archivedSnapshots],
  );

  const archivedGroups = useMemo(
    () =>
      buildArchivedThreadGroups({
        snapshots: archivedSnapshots,
        normalizedSearchQuery: archiveSearch.normalizedQuery,
        searchTokens: archiveSearch.tokens,
        isSearching: archiveSearch.isSearching,
        sort,
      }),
    [
      archiveSearch.isSearching,
      archiveSearch.normalizedQuery,
      archiveSearch.tokens,
      archivedSnapshots,
      sort,
    ],
  );

  const toggleProjectExpanded = useCallback((projectKey: string) => {
    setExpandedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  }, []);

  const handleSortClick = useCallback((field: ArchivedThreadSortField) => {
    setSort((current) => nextArchivedThreadSortState(current, field));
  }, []);

  const confirmArchivedAction = useCallback(async (message: string) => {
    const localApi = readLocalApi();
    const confirmationResult = await settlePromise(() =>
      localApi
        ? localApi.dialogs.confirm(message)
        : typeof window !== "undefined"
          ? Promise.resolve(window.confirm(message))
          : Promise.resolve(false),
    );
    if (confirmationResult._tag === "Failure") {
      const error = squashAtomCommandFailure(confirmationResult);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Archived thread confirmation failed",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return false;
    }
    return confirmationResult.value;
  }, []);

  const showArchivedActionFailure = useCallback(
    (title: string, result: AtomCommandResult<unknown, unknown>) => {
      if (result._tag === "Success") return;
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
    [],
  );

  const showArchivedBulkActionFailure = useCallback(
    (title: string, failures: ReadonlyArray<ArchivedProjectBulkFailure>, totalCount: number) => {
      const visibleFailures = failures.filter((failure) => !isAtomCommandInterrupted(failure));
      if (visibleFailures.length === 0) return;
      const error = squashAtomCommandFailure(visibleFailures[0]!);
      const interruptedCount = failures.length - visibleFailures.length;
      const successCount = totalCount - failures.length;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: [
            `${successCount} succeeded, ${visibleFailures.length} failed${
              interruptedCount > 0 ? `, ${interruptedCount} interrupted` : ""
            }.`,
            error instanceof Error ? error.message : "An error occurred.",
          ].join(" "),
        }),
      );
    },
    [],
  );

  const showArchivedProjectMenuFailure = useCallback(
    (result: AtomCommandResult<unknown, unknown>) => {
      if (result._tag === "Success") return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Archived project action failed",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
    [],
  );

  const handleUnarchiveThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      const result = await unarchiveThread(threadRef);
      if (result._tag === "Success") {
        refreshArchivedThreads();
        return;
      }
      showArchivedActionFailure("Failed to unarchive thread", result);
    },
    [refreshArchivedThreads, showArchivedActionFailure, unarchiveThread],
  );

  const handleDeleteArchivedThread = useCallback(
    async (threadRef: ScopedThreadRef, title: string) => {
      if (confirmThreadDelete) {
        const confirmed = await confirmArchivedAction(
          [
            `Delete archived conversation "${title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }
      const result = await deleteThread(threadRef);
      if (result._tag === "Success") {
        refreshArchivedThreads();
        return;
      }
      showArchivedActionFailure("Failed to delete thread", result);
    },
    [
      confirmArchivedAction,
      confirmThreadDelete,
      deleteThread,
      refreshArchivedThreads,
      showArchivedActionFailure,
    ],
  );

  const handleUnarchiveProjectThreads = useCallback(
    async (
      projectName: string,
      threads: ReadonlyArray<ArchivedProjectBulkThread>,
      scope: ArchivedProjectBulkScope,
    ) => {
      const scopeLabel = archivedProjectBulkScopeLabel(scope);
      const confirmed = await confirmArchivedAction(
        [
          `Unarchive ${scopeLabel} in "${projectName}"?`,
          `This will restore ${threads.length} conversation${threads.length === 1 ? "" : "s"}.`,
        ].join("\n"),
      );
      if (!confirmed) return;
      const failures = await runArchivedProjectThreadActions(threads, (thread) =>
        unarchiveThread(scopeThreadRef(thread.environmentId, thread.id)),
      );
      if (failures.length > 0) {
        showArchivedBulkActionFailure(
          "Archived threads not fully unarchived",
          failures,
          threads.length,
        );
      }
      refreshArchivedThreads();
    },
    [confirmArchivedAction, refreshArchivedThreads, showArchivedBulkActionFailure, unarchiveThread],
  );

  const handleDeleteProjectThreads = useCallback(
    async (
      projectName: string,
      threads: ReadonlyArray<ArchivedProjectBulkThread>,
      scope: ArchivedProjectBulkScope,
    ) => {
      const scopeLabel = archivedProjectBulkScopeLabel(scope);
      if (confirmThreadDelete) {
        const confirmed = await confirmArchivedAction(
          [
            `Delete ${scopeLabel} in "${projectName}"?`,
            `This permanently clears conversation history for ${threads.length} conversation${threads.length === 1 ? "" : "s"}.`,
          ].join("\n"),
        );
        if (!confirmed) return;
      }
      const failures = await runArchivedProjectThreadActions(threads, (thread) =>
        deleteThread(scopeThreadRef(thread.environmentId, thread.id)),
      );
      if (failures.length > 0) {
        showArchivedBulkActionFailure(
          "Archived threads not fully deleted",
          failures,
          threads.length,
        );
      }
      refreshArchivedThreads();
    },
    [
      confirmArchivedAction,
      confirmThreadDelete,
      deleteThread,
      refreshArchivedThreads,
      showArchivedBulkActionFailure,
    ],
  );

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, title: string, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        await handleUnarchiveThread(threadRef);
        return;
      }

      if (clicked === "delete") {
        await handleDeleteArchivedThread(threadRef, title);
      }
    },
    [handleDeleteArchivedThread, handleUnarchiveThread],
  );

  const handleArchivedProjectContextMenu = useCallback(
    async (
      projectName: string,
      threads: ReadonlyArray<ArchivedProjectBulkThread>,
      scope: ArchivedProjectBulkScope,
      position: { x: number; y: number },
    ) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive-all", label: "Unarchive all" },
          { id: "delete-all", label: "Delete all", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive-all") {
        await handleUnarchiveProjectThreads(projectName, threads, scope);
        return;
      }

      if (clicked === "delete-all") {
        await handleDeleteProjectThreads(projectName, threads, scope);
      }
    },
    [handleDeleteProjectThreads, handleUnarchiveProjectThreads],
  );

  const handleArchivedProjectMenuButton = useCallback(
    async (
      projectName: string,
      threads: ReadonlyArray<ArchivedProjectBulkThread>,
      scope: ArchivedProjectBulkScope,
      trigger: HTMLElement,
    ) => {
      const rect = trigger.getBoundingClientRect();
      const result = await settlePromise(() =>
        handleArchivedProjectContextMenu(projectName, threads, scope, {
          x: rect.right,
          y: rect.bottom,
        }),
      );
      showArchivedProjectMenuFailure(result);
    },
    [handleArchivedProjectContextMenu, showArchivedProjectMenuFailure],
  );

  return (
    <SettingsPageContainer>
      <Input
        nativeInput
        type="search"
        value={archiveSearchQuery}
        onChange={(event) => setArchiveSearchQuery(event.currentTarget.value)}
        placeholder="Search archived conversations"
        aria-label="Search archived conversations"
      />
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? "Loading archived threads"
                  : archiveError
                    ? "Could not load archived threads"
                    : archiveSearch.isSearching && hasArchivedThreads
                      ? "No matching archived threads"
                      : "No archived threads"}
              </span>
            }
            description={
              isLoadingArchive
                ? "Checking connected environments."
                : archiveError
                  ? archiveError
                  : archiveSearch.isSearching && hasArchivedThreads
                    ? `No archived conversation titles match "${archiveSearchQuery.trim()}".`
                    : "Archived threads will appear here."
            }
          />
        </SettingsSection>
      ) : (
        <div className="space-y-3">
          {archivedGroups.map(({ key: projectKey, project, threads: projectThreads }) => {
            const isExpanded = archiveSearch.isSearching || expandedProjectKeys.has(projectKey);
            const bulkScope = archiveSearch.isSearching ? "matching" : "all";
            return (
              <section
                key={projectKey}
                className="border-t border-border/70 pt-3 first:border-t-0 first:pt-0"
              >
                <div
                  className={
                    isExpanded
                      ? "grid grid-cols-[minmax(0,1fr)_4.75rem_4.75rem_1.75rem] items-center gap-2 px-1"
                      : "grid grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-2 px-1"
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void (async () => {
                      const result = await settlePromise(() =>
                        handleArchivedProjectContextMenu(project.name, projectThreads, bulkScope, {
                          x: event.clientX,
                          y: event.clientY,
                        }),
                      );
                      showArchivedProjectMenuFailure(result);
                    })();
                  }}
                >
                  <button
                    type="button"
                    className="group flex min-w-0 items-center gap-2 text-left"
                    disabled={archiveSearch.isSearching}
                    aria-expanded={isExpanded}
                    onClick={() => toggleProjectExpanded(projectKey)}
                  >
                    {isExpanded ? (
                      <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                    ) : (
                      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                    )}
                    <ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />
                    <span className="truncate text-[13px] font-semibold text-foreground group-hover:text-foreground/85">
                      {project.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground/60">
                      {projectThreads.length}
                    </span>
                  </button>
                  {isExpanded ? (
                    <>
                      <ArchivedSortButton
                        field="archivedAt"
                        label="Archived"
                        sort={sort}
                        onClick={() => handleSortClick("archivedAt")}
                      />
                      <ArchivedSortButton
                        field="createdAt"
                        label="Created"
                        sort={sort}
                        onClick={() => handleSortClick("createdAt")}
                      />
                    </>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Project actions for ${project.name}`}
                          className="size-6 rounded-md justify-self-end"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleArchivedProjectMenuButton(
                              project.name,
                              projectThreads,
                              bulkScope,
                              event.currentTarget,
                            );
                          }}
                        >
                          <EllipsisIcon className="size-3.5" />
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">Project actions</TooltipPopup>
                  </Tooltip>
                </div>
                {isExpanded ? (
                  <div className="mt-1 space-y-0.5">
                    {projectThreads.map((thread) => (
                      <div
                        key={thread.id}
                        className="group relative grid grid-cols-[minmax(0,1fr)_4.75rem_4.75rem_1.75rem] items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-within:bg-accent focus-within:text-foreground"
                        onContextMenu={(event) => {
                          event.preventDefault();
                          void (async () => {
                            const result = await settlePromise(() =>
                              handleArchivedThreadContextMenu(
                                scopeThreadRef(thread.environmentId, thread.id),
                                thread.title,
                                {
                                  x: event.clientX,
                                  y: event.clientY,
                                },
                              ),
                            );
                            if (result._tag === "Failure") {
                              const error = squashAtomCommandFailure(result);
                              toastManager.add(
                                stackedThreadToast({
                                  type: "error",
                                  title: "Archived thread action failed",
                                  description:
                                    error instanceof Error ? error.message : "An error occurred.",
                                }),
                              );
                            }
                          })();
                        }}
                      >
                        <div className="min-w-0 truncate text-[13px] font-medium text-current">
                          {thread.title}
                        </div>
                        <div className="pointer-events-none truncate text-right font-mono text-[11px] text-muted-foreground/75 transition-[color,opacity] duration-150 group-hover:opacity-0 group-hover:text-current group-focus-within:opacity-0 group-focus-within:text-current">
                          {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                        </div>
                        <div className="pointer-events-none truncate text-right font-mono text-[11px] text-muted-foreground/75 transition-[color,opacity] duration-150 group-hover:opacity-0 group-hover:text-current group-focus-within:opacity-0 group-focus-within:text-current">
                          {formatRelativeTimeLabel(thread.createdAt)}
                        </div>
                        <div aria-hidden="true" />
                        <div
                          className="pointer-events-none absolute top-1/2 right-1 z-10 flex -translate-y-1/2 items-center gap-1 rounded-md bg-accent/95 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <ArchivedIconButton
                            label="Unarchive"
                            onClick={() => {
                              void handleUnarchiveThread(
                                scopeThreadRef(thread.environmentId, thread.id),
                              );
                            }}
                          >
                            <ArchiveX className="size-3.5" />
                          </ArchivedIconButton>
                          <ArchivedIconButton
                            label="Delete"
                            destructive
                            onClick={() => {
                              void handleDeleteArchivedThread(
                                scopeThreadRef(thread.environmentId, thread.id),
                                thread.title,
                              );
                            }}
                          >
                            <Trash2Icon className="size-3.5" />
                          </ArchivedIconButton>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </SettingsPageContainer>
  );
}
