import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import { ArchiveIcon, ArchiveRestoreIcon, CheckCheckIcon, Trash2Icon } from "lucide-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type AtomCommandResult,
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
import { useSearchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";

import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useRef, useState } from "react";

const ARCHIVE_ACTIONS = [
  {
    action: "unarchive",
    label: msg("Unarchive"),
    threadLabel: msg("Unarchive {title}"),
    failureTitle: msg("Failed to unarchive thread"),
    Icon: ArchiveRestoreIcon,
  },
  {
    action: "delete",
    label: msg("Delete", { $context: "verb, deletes a thread" }),
    threadLabel: msg("Delete {title}"),
    failureTitle: msg("Failed to delete thread"),
    Icon: Trash2Icon,
  },
] as const;
type ArchiveAction = (typeof ARCHIVE_ACTIONS)[number]["action"];

export function ArchivedThreadsPanel() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const { scope, groups: projectGroups, environments } = useSettingsScope();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const pendingActionsRef = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
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

  type ArchivedThread = (typeof archivedGroups)[number]["threads"][number];

  const reportFailure = (result: AtomCommandResult<unknown, unknown> | null, title: string) => {
    if (result?._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description:
          error instanceof Error
            ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
            : gt("An error occurred."),
      }),
    );
  };

  const handleThreadAction = async (action: ArchiveAction, thread: ArchivedThread) => {
    const target = scopeThreadRef(thread.environmentId, thread.id);
    const key = scopedThreadKey(target);
    // Context menus can outlive their render, so checks and cleanup use the live set.
    const pending = pendingActionsRef.current;
    if (pending.has(key)) return;
    pending.add(key);
    setPendingKeys(new Set(pending));
    const result = await settlePromise(async () => {
      const result = await (action === "unarchive"
        ? unarchiveThread(target)
        : confirmAndDeleteThread(target, thread.title));
      if (result._tag === "Success") refreshArchivedThreads();
      return result;
    }).finally(() => {
      pending.delete(key);
      setPendingKeys(new Set(pending));
    });
    reportFailure(
      result._tag === "Failure" ? result : result.value,
      m(ARCHIVE_ACTIONS.find((entry) => entry.action === action)!.failureTitle),
    );
  };

  const handleContextMenu = async (thread: ArchivedThread, position: { x: number; y: number }) => {
    const pending = pendingActionsRef.current;
    if (pending.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))) return;
    const result = await settlePromise(async () => {
      const clicked = await readLocalApi()?.contextMenu.show(
        ARCHIVE_ACTIONS.map(({ action, label }) => ({
          id: action,
          label: m(label),
          destructive: action === "delete",
        })),
        position,
      );
      if (clicked === "unarchive" || clicked === "delete")
        await handleThreadAction(clicked, thread);
    });
    reportFailure(result, gt("Archived thread action failed"));
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
            placeholder={gt("Search archived threads")}
          />
        </SettingsToolbar>
      ) : null}
      {allArchivedGroups.length > 0 && archivedGroups.length === 0 ? (
        <SettingsNoMatches onClear={() => setArchiveQuery("")}>
          <T>
            No archived threads match “<Var>{archiveQuery.trim()}</Var>”.
          </T>
        </SettingsNoMatches>
      ) : null}
      {allArchivedGroups.length === 0 && (isLoadingArchive || archiveError) ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive").id}
          title={searchableSetting("archive").title}
          hideTitle
        >
          {isLoadingArchive ? (
            <SettingsLoadingRows label={gt("Loading archived threads")} />
          ) : (
            <SettingsRow
              title={
                <span className="inline-flex items-center gap-2">
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                  {gt("Could not load archived threads")}
                </span>
              }
              description={archiveError}
            />
          )}
        </SettingsSection>
      ) : allArchivedGroups.length === 0 ? (
        <section id={searchableSetting("archive").id} tabIndex={-1} className="pt-19">
          <SettingsEmptyState
            align="start"
            ghostRows={3}
            title={gt("No archived threads")}
            description={gt(
              "Threads you archive stay searchable here and can be restored at any time.",
            )}
          >
            <SettingsEmptyTiles narrow>
              <SettingsEmptyTile
                icon={<ArchiveIcon />}
                title={gt("Archive a thread")}
                description={gt("From its menu in the sidebar.")}
              />
              <SettingsEmptyTile
                icon={<CheckCheckIcon />}
                title={gt("Settled threads")}
                description={gt("Cleared from Settled.")}
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
            {projectThreads.map((thread) => {
              const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
              return (
                <SettingsRow
                  key={`${thread.environmentId}:${thread.id}`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void handleContextMenu(thread, { x: event.clientX, y: event.clientY });
                  }}
                  title={thread.title}
                  description={
                    <span className={hasMultipleEnvironments ? "block truncate" : undefined}>
                      {hasMultipleEnvironments ? (
                        <span className="mb-1 block">{thread.environmentLabel}</span>
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger render={<span tabIndex={0} />}>
                          <T>
                            Archived{" "}
                            <RelativeTime timestamp={thread.archivedAt ?? thread.createdAt} />
                          </T>
                        </TooltipTrigger>
                        <TooltipPopup side="top">
                          <T>
                            Created <RelativeTime timestamp={thread.createdAt} />
                          </T>
                        </TooltipPopup>
                      </Tooltip>
                      {thread.messageCount === undefined ? null : (
                        <span className="mt-1 block">
                          {gt("{count, plural, one {{count} message} other {{count} messages}}", {
                            count: thread.messageCount,
                          })}
                        </span>
                      )}
                    </span>
                  }
                  control={
                    <div className="flex shrink-0 items-center gap-2">
                      {ARCHIVE_ACTIONS.map(({ action, label, threadLabel, Icon }) => (
                        <Tooltip key={action}>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                variant={action === "delete" ? "destructive-outline" : "secondary"}
                                size="icon-sm"
                                aria-label={m(threadLabel, { title: thread.title })}
                                disabled={pendingKeys.has(threadKey)}
                                onClick={() => void handleThreadAction(action, thread)}
                              />
                            }
                          >
                            <Icon className="size-3.5" />
                          </TooltipTrigger>
                          <TooltipPopup>{m(label)}</TooltipPopup>
                        </Tooltip>
                      ))}
                    </div>
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
