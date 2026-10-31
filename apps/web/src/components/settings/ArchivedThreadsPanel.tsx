import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import { ArchiveIcon, ArchiveRestoreIcon, CheckCheckIcon } from "lucide-react";
import { useState } from "react";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useSettingsScope } from "./SettingsScopeContext";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsToolbar,
  SettingsSearchField,
  SettingsNoMatches,
  SettingsLoadingRows,
  SettingsEmptyState,
  SettingsEmptyTiles,
  SettingsEmptyTile,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";

export function ArchivedThreadsPanel() {
  const { scope, groups: projectGroups, environments } = useSettingsScope();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(scope.environmentIds);
  const [archiveQuery, setArchiveQuery] = useState("");
  const normalizedArchiveQuery = archiveQuery.trim().toLowerCase();

  const { groups: allArchivedGroups, hasMultipleEnvironments } = (() => {
    const selectedProjectKeys =
      scope.kind === "project" || scope.kind === "checkout"
        ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
        : null;
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects
          .filter(
            (project) =>
              selectedProjectKeys === null ||
              selectedProjectKeys.has(`${environmentId}:${project.id}`),
          )
          .map(
            (project) => [`${environmentId}:${project.id}`, { ...project, environmentId }] as const,
          ),
      ),
    );
    const environmentLabels = new Map(
      environments.map((environment) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        return [environment.environmentId, secondary ? `${primary} (${secondary})` : primary];
      }),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...presentThreadShell(environmentId, thread),
        projectTitle:
          projectsByEnvironmentAndId.get(`${environmentId}:${thread.projectId}`)?.title ?? "",
        environmentLabel: environmentLabels.get(environmentId) ?? environmentId,
      })),
    );
    const hasMultipleEnvironments =
      new Set(
        threads
          .filter((thread) =>
            projectsByEnvironmentAndId.has(`${thread.environmentId}:${thread.projectId}`),
          )
          .map((thread) => thread.environmentId),
      ).size > 1;
    const logicalGroupsByProjectKey = new Map(
      projectGroups.flatMap((group) =>
        group.memberProjectRefs.map(
          (member) => [`${member.environmentId}:${member.projectId}`, group] as const,
        ),
      ),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups = new Map<
      string,
      {
        readonly project: (typeof archivedProjects)[number];
        readonly title: string;
        readonly threads: Array<(typeof threads)[number]>;
      }
    >();
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        const physicalProjectKey = `${project.environmentId}:${project.id}` as const;
        const logicalGroup = hasMultipleEnvironments
          ? logicalGroupsByProjectKey.get(physicalProjectKey)
          : undefined;
        const groupKey = logicalGroup?.projectKey ?? physicalProjectKey;
        const group = groups.get(groupKey);
        if (group) {
          group.threads.push(...projectThreads);
        } else {
          groups.set(groupKey, {
            project,
            title: logicalGroup?.displayName ?? project.title,
            threads: projectThreads,
          });
        }
      }
    }
    const sortedGroups = Array.from(groups, ([key, group]) => ({
      ...group,
      key,
      threads: group.threads.toSorted((left, right) => {
        const leftKey = left.archivedAt ?? left.createdAt;
        const rightKey = right.archivedAt ?? right.createdAt;
        return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
      }),
    }));
    return { groups: sortedGroups, hasMultipleEnvironments };
  })();
  // Filters the loaded snapshots on the client: a thread matches on its title
  // or its project's name.
  const archivedGroups = (() => {
    if (normalizedArchiveQuery.length === 0) return allArchivedGroups;
    return allArchivedGroups.flatMap((group) => {
      const projectMatches = group.title.toLowerCase().includes(normalizedArchiveQuery);
      const threads = projectMatches
        ? group.threads
        : group.threads.filter(
            (thread) =>
              thread.title.toLowerCase().includes(normalizedArchiveQuery) ||
              thread.projectTitle.toLowerCase().includes(normalizedArchiveQuery),
          );
      return threads.length > 0 ? [{ ...group, threads }] : [];
    });
  })();

  const handleArchivedThreadContextMenu = async (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => {
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
  };

  return (
    <SettingsPageContainer
      centered={allArchivedGroups.length === 0 && !isLoadingArchive && !archiveError}
    >
      {allArchivedGroups.length > 0 ? (
        <SettingsToolbar>
          <SettingsSearchField
            value={archiveQuery}
            onChange={setArchiveQuery}
            placeholder="Search archived threads"
          />
        </SettingsToolbar>
      ) : null}
      {allArchivedGroups.length > 0 && archivedGroups.length === 0 ? (
        <SettingsNoMatches onClear={() => setArchiveQuery("")}>
          No archived threads match “{archiveQuery.trim()}”.
        </SettingsNoMatches>
      ) : null}
      {allArchivedGroups.length === 0 && (isLoadingArchive || archiveError) ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive").id}
          title={searchableSetting("archive").title}
          hideTitle
        >
          {isLoadingArchive ? (
            <SettingsLoadingRows label="Loading archived threads" />
          ) : (
            <SettingsRow
              title={
                <span className="inline-flex items-center gap-2">
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                  Could not load archived threads
                </span>
              }
              description={archiveError}
            />
          )}
        </SettingsSection>
      ) : allArchivedGroups.length === 0 ? (
        <section id={searchableSetting("archive").id} tabIndex={-1}>
          <SettingsEmptyState
            ghostRows={3}
            title="No archived threads"
            description="Threads you archive stay searchable here and can be restored at any time."
          >
            <SettingsEmptyTiles narrow>
              <SettingsEmptyTile
                icon={<ArchiveIcon />}
                title="Archive a thread"
                description="From its menu in the sidebar."
              />
              <SettingsEmptyTile
                icon={<CheckCheckIcon />}
                title="Settled threads"
                description="Cleared from Settled."
              />
            </SettingsEmptyTiles>
          </SettingsEmptyState>
        </section>
      ) : (
        archivedGroups.map(({ key, project, title, threads: projectThreads }, index) => (
          <SettingsSection
            key={key}
            id={index === 0 ? searchableSetting("archive").id : undefined}
            title={title}
            icon={<ProjectFavicon project={project} />}
          >
            {projectThreads.map((thread) => (
              <SettingsRow
                key={`${thread.environmentId}:${thread.id}`}
                onContextMenu={(event) => {
                  event.preventDefault();
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
                  <span className={hasMultipleEnvironments ? "block truncate" : undefined}>
                    {hasMultipleEnvironments ? `${thread.environmentLabel} · ` : null}
                    Archived <RelativeTime timestamp={thread.archivedAt ?? thread.createdAt} />
                    {thread.messageCount === undefined ? (
                      <>
                        {" \u00b7 Created "}
                        <RelativeTime timestamp={thread.createdAt} />
                      </>
                    ) : (
                      ` \u00b7 ${thread.messageCount} ${thread.messageCount === 1 ? "message" : "messages"}`
                    )}
                  </span>
                }
                control={
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                    onClick={() => {
                      void (async () => {
                        const result = await unarchiveThread(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        if (result._tag === "Success") {
                          refreshArchivedThreads();
                          return;
                        }
                        if (!isAtomCommandInterrupted(result)) {
                          const error = squashAtomCommandFailure(result);
                          toastManager.add(
                            stackedThreadToast({
                              type: "error",
                              title: "Failed to unarchive thread",
                              description:
                                error instanceof Error ? error.message : "An error occurred.",
                            }),
                          );
                        }
                      })();
                    }}
                  >
                    <ArchiveRestoreIcon className="size-3.5" />
                    <span>Unarchive</span>
                  </Button>
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
