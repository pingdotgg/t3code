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
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
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
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
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
  archivedProjectBulkFailureDescription,
  archivedThreadTimestampValue,
  archivedThreadActionKey,
  type ArchivedProjectBulkFailure,
  type ArchivedProjectBulkScope,
  type ArchivedProjectBulkThread,
  type ArchivedThreadSortField,
  type ArchivedThreadSortState,
  buildArchivedThreadGroups,
  hasArchivedThreads as archiveHasThreads,
  nextArchivedThreadSortState,
  parseArchivedThreadSearchInput,
  releaseArchivedThreadActionLock,
  resolveArchivedProjectEnvironmentLabel,
  runArchivedProjectThreadActions,
  tryAcquireArchivedThreadActionLock,
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
  disabled = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
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
            disabled={disabled}
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
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { unarchiveThread, deleteThread } = useThreadActions();
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const inFlightArchivedThreadKeysRef = useRef(new Set<string>());
  const [inFlightArchivedThreadKeys, setInFlightArchivedThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
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
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const archiveEnvironmentsById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [
          environment.environmentId,
          {
            environmentId: environment.environmentId,
            label: environment.label,
            isPrimary: environment.environmentId === primaryEnvironmentId,
          },
        ]),
      ),
    [environments, primaryEnvironmentId],
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
    () => archiveHasThreads(archivedSnapshots),
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

  const tryReserveArchivedThreadActions = useCallback(
    (
      threadRefs: ReadonlyArray<ScopedThreadRef>,
    ): { readonly start: () => void; readonly finish: () => void } | null => {
      const lock = tryAcquireArchivedThreadActionLock(
        inFlightArchivedThreadKeysRef.current,
        threadRefs,
      );
      if (!lock) {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Archive action already in progress",
            description: "Wait for the current archived thread action to finish.",
          }),
        );
        return null;
      }
      let started = false;
      return {
        start: () => {
          if (started) return;
          started = true;
          setInFlightArchivedThreadKeys(new Set(inFlightArchivedThreadKeysRef.current));
        },
        finish: () => {
          releaseArchivedThreadActionLock(inFlightArchivedThreadKeysRef.current, lock);
          if (started) {
            setInFlightArchivedThreadKeys(new Set(inFlightArchivedThreadKeysRef.current));
          }
        },
      };
    },
    [],
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
    if (!localApi) return true;
    const confirmationResult = await settlePromise(() => localApi.dialogs.confirm(message));
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
      const description = archivedProjectBulkFailureDescription(failures, totalCount);
      if (!description) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description,
        }),
      );
    },
    [],
  );

  const showArchivedBulkActionException = useCallback((title: string, error: unknown) => {
    const errors = error instanceof AggregateError ? error.errors : [error];
    const failureMessages = [
      ...new Set(
        errors.map((entry) => (entry instanceof Error ? entry.message : "An error occurred.")),
      ),
    ];
    const shownFailureMessages = failureMessages.slice(0, 3);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: [
          `One or more archived thread actions failed unexpectedly.`,
          failureMessages.length <= 1
            ? (shownFailureMessages[0] ?? "An error occurred.")
            : `Failures: ${shownFailureMessages.join("; ")}${
                failureMessages.length > shownFailureMessages.length
                  ? `; ${failureMessages.length - shownFailureMessages.length} more`
                  : ""
              }`,
        ].join(" "),
      }),
    );
  }, []);

  const handleUnarchiveThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      const reservation = tryReserveArchivedThreadActions([threadRef]);
      if (!reservation) return;
      reservation.start();
      try {
        const result = await unarchiveThread(threadRef);
        showArchivedActionFailure("Failed to unarchive thread", result);
      } finally {
        reservation.finish();
      }
    },
    [showArchivedActionFailure, tryReserveArchivedThreadActions, unarchiveThread],
  );

  const handleDeleteArchivedThread = useCallback(
    async (threadRef: ScopedThreadRef, title: string) => {
      const reservation = tryReserveArchivedThreadActions([threadRef]);
      if (!reservation) return;
      try {
        if (confirmThreadDelete) {
          const confirmed = await confirmArchivedAction(
            [
              `Delete archived conversation "${title}"?`,
              "This permanently clears conversation history for this thread.",
            ].join("\n"),
          );
          if (!confirmed) return;
        }
        reservation.start();
        const result = await deleteThread(threadRef);
        showArchivedActionFailure("Failed to delete thread", result);
      } finally {
        reservation.finish();
      }
    },
    [
      confirmArchivedAction,
      confirmThreadDelete,
      deleteThread,
      showArchivedActionFailure,
      tryReserveArchivedThreadActions,
    ],
  );

  const handleUnarchiveProjectThreads = useCallback(
    async (
      projectName: string,
      threads: ReadonlyArray<ArchivedProjectBulkThread>,
      scope: ArchivedProjectBulkScope,
    ) => {
      const threadRefs = threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id));
      const reservation = tryReserveArchivedThreadActions(threadRefs);
      if (!reservation) return;
      try {
        const scopeLabel = archivedProjectBulkScopeLabel(scope);
        // Bulk unarchive always asks because there is no unarchive confirmation preference.
        const confirmed = await confirmArchivedAction(
          [
            `Unarchive ${scopeLabel} in "${projectName}"?`,
            `This will restore ${threads.length} conversation${threads.length === 1 ? "" : "s"}.`,
          ].join("\n"),
        );
        if (!confirmed) return;
        reservation.start();
        try {
          const failures = await runArchivedProjectThreadActions(threads, (thread) =>
            unarchiveThread(scopeThreadRef(thread.environmentId, thread.id), {
              refreshArchivedThreads: false,
            }),
          );
          if (failures.length > 0) {
            showArchivedBulkActionFailure(
              "Archived threads not fully unarchived",
              failures,
              threads.length,
            );
          }
        } catch (error) {
          showArchivedBulkActionException("Archived threads not fully unarchived", error);
        } finally {
          refreshArchivedThreads();
        }
      } finally {
        reservation.finish();
      }
    },
    [
      confirmArchivedAction,
      refreshArchivedThreads,
      showArchivedBulkActionException,
      showArchivedBulkActionFailure,
      tryReserveArchivedThreadActions,
      unarchiveThread,
    ],
  );

  const handleDeleteProjectThreads = useCallback(
    async (
      projectName: string,
      threads: ReadonlyArray<ArchivedProjectBulkThread>,
      scope: ArchivedProjectBulkScope,
    ) => {
      const threadRefs = threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id));
      const reservation = tryReserveArchivedThreadActions(threadRefs);
      if (!reservation) return;
      try {
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
        reservation.start();
        try {
          const failures = await runArchivedProjectThreadActions(threads, (thread) =>
            deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
              refreshArchivedThreads: false,
            }),
          );
          if (failures.length > 0) {
            showArchivedBulkActionFailure(
              "Archived threads not fully deleted",
              failures,
              threads.length,
            );
          }
        } catch (error) {
          showArchivedBulkActionException("Archived threads not fully deleted", error);
        } finally {
          refreshArchivedThreads();
        }
      } finally {
        reservation.finish();
      }
    },
    [
      confirmArchivedAction,
      confirmThreadDelete,
      deleteThread,
      refreshArchivedThreads,
      showArchivedBulkActionException,
      showArchivedBulkActionFailure,
      tryReserveArchivedThreadActions,
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
          {
            id: "unarchive-all",
            label: scope === "matching" ? "Unarchive matching" : "Unarchive all",
          },
          {
            id: "delete-all",
            label: scope === "matching" ? "Delete matching" : "Delete all",
            destructive: true,
          },
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
      showArchivedActionFailure("Archived project action failed", result);
    },
    [handleArchivedProjectContextMenu, showArchivedActionFailure],
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
            const projectHasInFlightAction = projectThreads.some((thread) =>
              inFlightArchivedThreadKeys.has(
                archivedThreadActionKey(scopeThreadRef(thread.environmentId, thread.id)),
              ),
            );
            const environmentLabel = resolveArchivedProjectEnvironmentLabel({
              environment: archiveEnvironmentsById.get(project.environmentId) ?? null,
              hasMultipleEnvironments: environments.length > 1,
            });
            return (
              <section
                key={projectKey}
                className="border-t border-border/70 pt-3 first:border-t-0 first:pt-0"
                aria-busy={projectHasInFlightAction}
              >
                <div
                  className={
                    isExpanded
                      ? "grid grid-cols-[minmax(0,1fr)_4.75rem_4.75rem_1.75rem] items-center gap-2 px-1"
                      : "grid grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-2 px-1"
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (projectHasInFlightAction) return;
                    void (async () => {
                      const result = await settlePromise(() =>
                        handleArchivedProjectContextMenu(project.name, projectThreads, bulkScope, {
                          x: event.clientX,
                          y: event.clientY,
                        }),
                      );
                      showArchivedActionFailure("Archived project action failed", result);
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
                    {environmentLabel ? (
                      <span
                        className="max-w-[30%] shrink-0 truncate text-[11px] text-muted-foreground/60"
                        title={environmentLabel}
                      >
                        {environmentLabel}
                      </span>
                    ) : null}
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
                          disabled={projectHasInFlightAction}
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
                    {projectThreads.map((thread) => {
                      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
                      const threadHasInFlightAction = inFlightArchivedThreadKeys.has(
                        archivedThreadActionKey(threadRef),
                      );
                      return (
                        <div
                          key={thread.id}
                          className="group relative grid grid-cols-[minmax(0,1fr)_4.75rem_4.75rem_1.75rem] items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-within:bg-accent focus-within:text-foreground"
                          aria-busy={threadHasInFlightAction}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            if (threadHasInFlightAction) return;
                            void (async () => {
                              const result = await settlePromise(() =>
                                handleArchivedThreadContextMenu(threadRef, thread.title, {
                                  x: event.clientX,
                                  y: event.clientY,
                                }),
                              );
                              showArchivedActionFailure("Archived thread action failed", result);
                            })();
                          }}
                        >
                          <div className="min-w-0 truncate text-[13px] font-medium text-current">
                            {thread.title}
                          </div>
                          <div className="pointer-events-none truncate text-right font-mono text-[11px] text-muted-foreground/75 transition-[color,opacity] duration-150 group-hover:opacity-0 group-hover:text-current group-focus-within:opacity-0 group-focus-within:text-current">
                            {formatRelativeTimeLabel(
                              archivedThreadTimestampValue(thread, "archivedAt"),
                            )}
                          </div>
                          <div className="pointer-events-none truncate text-right font-mono text-[11px] text-muted-foreground/75 transition-[color,opacity] duration-150 group-hover:opacity-0 group-hover:text-current group-focus-within:opacity-0 group-focus-within:text-current">
                            {formatRelativeTimeLabel(thread.createdAt)}
                          </div>
                          {/* Keeps row text columns aligned with the header action column. */}
                          <div aria-hidden="true" />
                          <div
                            className="pointer-events-none absolute top-1/2 right-1 z-10 flex -translate-y-1/2 items-center gap-1 rounded-md bg-accent/95 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <ArchivedIconButton
                              label="Unarchive"
                              disabled={threadHasInFlightAction}
                              onClick={() => {
                                void handleUnarchiveThread(threadRef);
                              }}
                            >
                              <ArchiveX className="size-3.5" />
                            </ArchivedIconButton>
                            <ArchivedIconButton
                              label="Delete"
                              destructive
                              disabled={threadHasInFlightAction}
                              onClick={() => {
                                void handleDeleteArchivedThread(threadRef, thread.title);
                              }}
                            >
                              <Trash2Icon className="size-3.5" />
                            </ArchivedIconButton>
                          </div>
                        </div>
                      );
                    })}
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
