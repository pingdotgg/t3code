import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ArchiveIcon, ArchiveX, LoaderIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { readLocalApi } from "../../localApi";
import { useProjects } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { archivedThreadContextMenuItems } from "./ArchivedThreadsPanel.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function ArchivedThreadsPanel() {
  const projects = useProjects();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const [unarchivingThreadKeys, setUnarchivingThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const unarchivingThreadKeysRef = useRef(new Set<string>());
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

  const archivedGroups = useMemo(() => {
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects.map(
          (project) =>
            [
              `${environmentId}:${project.id}`,
              {
                id: project.id,
                environmentId,
                name: project.title,
                cwd: project.workspaceRoot,
                faviconPath: project.faviconPath,
              },
            ] as const,
        ),
      ),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...thread,
        environmentId,
      })),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups: Array<{
      readonly project: (typeof archivedProjects)[number];
      readonly threads: Array<(typeof threads)[number]>;
    }> = [];
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        groups.push({
          project,
          threads: projectThreads.toSorted((left, right) => {
            const leftKey = toSortableTimestamp(left.archivedAt ?? left.createdAt);
            const rightKey = toSortableTimestamp(right.archivedAt ?? right.createdAt);
            return (
              (rightKey ?? Number.NEGATIVE_INFINITY) - (leftKey ?? Number.NEGATIVE_INFINITY) ||
              right.id.localeCompare(left.id)
            );
          }),
        });
      }
    }
    return groups;
  }, [archivedSnapshots]);

  const handleUnarchiveThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      const threadKey = scopedThreadKey(threadRef);
      if (unarchivingThreadKeysRef.current.has(threadKey)) return;
      unarchivingThreadKeysRef.current.add(threadKey);
      setUnarchivingThreadKeys((current) => new Set(current).add(threadKey));
      try {
        const result = await unarchiveThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      } finally {
        unarchivingThreadKeysRef.current.delete(threadKey);
        setUnarchivingThreadKeys((current) => {
          const next = new Set(current);
          next.delete(threadKey);
          return next;
        });
      }
    },
    [refreshArchivedThreads, unarchiveThread],
  );

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(archivedThreadContextMenuItems, position);

      if (clicked === "unarchive") {
        await handleUnarchiveThread(threadRef);
        return;
      }

      if (clicked === "delete") {
        const result = await confirmAndDeleteThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to delete thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      }
    },
    [confirmAndDeleteThread, handleUnarchiveThread, refreshArchivedThreads],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length > 0 && archiveError ? (
        <SettingsSection
          id={searchableSetting("archive").id}
          title={searchableSetting("archive").title}
        >
          <SettingsRow title="Could not load all archived threads" description={archiveError} />
        </SettingsSection>
      ) : null}
      {archivedGroups.length === 0 ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive").id}
          title={searchableSetting("archive").title}
        >
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
                    : "No archived threads"}
              </span>
            }
            description={
              isLoadingArchive
                ? "Checking connected environments."
                : (archiveError ?? "Archived threads will appear here.")
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }, index) => (
          <SettingsSection
            key={`${project.environmentId}:${project.id}`}
            id={index === 0 && !archiveError ? searchableSetting("archive").id : undefined}
            title={project.name}
            icon={
              <ProjectFavicon
                environmentId={project.environmentId}
                cwd={project.cwd}
                faviconPath={project.faviconPath}
              />
            }
          >
            {projectThreads.map((thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              const isUnarchiving = unarchivingThreadKeys.has(scopedThreadKey(threadRef));
              return (
                <SettingsRow
                  key={scopedThreadKey(threadRef)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (isUnarchiving) return;
                    void (async () => {
                      const result = await settlePromise(() =>
                        handleArchivedThreadContextMenu(
                          scopeThreadRef(thread.environmentId, thread.id),
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
                  title={thread.title}
                  description={
                    <>
                      Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                      {" \u00b7 Created "}
                      {formatRelativeTimeLabel(thread.createdAt)}
                    </>
                  }
                  control={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                      disabled={isUnarchiving}
                      onClick={() => {
                        void handleUnarchiveThread(threadRef);
                      }}
                    >
                      {isUnarchiving ? (
                        <LoaderIcon className="size-3.5 animate-spin" />
                      ) : (
                        <ArchiveX className="size-3.5" />
                      )}
                      <span>{isUnarchiving ? "Unarchiving" : "Unarchive"}</span>
                    </Button>
                  }
                />
              );
            })}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
