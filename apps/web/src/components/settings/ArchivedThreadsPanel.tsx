import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import { Spinner } from "~/components/ui/spinner";
import { ArchiveIcon, ArchiveX, Trash2Icon } from "lucide-react";
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
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";

import { msg, T, useGT, useMessages } from "gt-react";
import { type ReactNode, useRef, useState } from "react";
import { observeIntersection } from "~/lib/observeIntersection";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

const ARCHIVE_ACTIONS = [
  {
    action: "unarchive",
    label: msg("Unarchive"),
    threadLabel: msg("Unarchive {title}"),
    failureTitle: msg("Failed to unarchive thread"),
    Icon: ArchiveX,
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

const ARCHIVED_ROW_CHUNK_SIZE = 50;
const ESTIMATED_ARCHIVED_ROW_PX = 67;

// Thousands of archived threads would mount at once, so each chunk of rows mounts only near the
// visible part of the settings scroller and otherwise keeps its last measured height.
function ArchivedThreadChunk(props: {
  readonly rowCount: number;
  readonly initiallyMounted: boolean;
  readonly renderRows: () => ReactNode;
}) {
  const { rowCount } = props;
  const [view, setView] = useState({
    near: props.initiallyMounted,
    rowHeight: ESTIMATED_ARCHIVED_ROW_PX,
  });
  return (
    <div
      ref={(node) => {
        if (!node) return;
        return observeIntersection(
          node,
          (entry) =>
            setView({
              near: entry.isIntersecting,
              rowHeight: entry.boundingClientRect.height / rowCount,
            }),
          { root: node.closest("[data-settings-page-scroll]"), rootMargin: "1200px 0px" },
        );
      }}
      className="*:not-first:border-t *:not-first:border-border/50"
      style={view.near ? undefined : { height: view.rowHeight * rowCount }}
    >
      {view.near ? props.renderRows() : null}
    </div>
  );
}

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

  const { groups: archivedGroups, hasMultipleEnvironments } = (() => {
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
    const sortedGroups = [];
    let firstRow = 0;
    for (const [key, group] of groups) {
      sortedGroups.push({
        ...group,
        key,
        firstRow,
        threads: group.threads.toSorted((left, right) => {
          const leftKey = left.archivedAt ?? left.createdAt;
          const rightKey = right.archivedAt ?? right.createdAt;
          return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
        }),
      });
      firstRow += group.threads.length;
    }
    return { groups: sortedGroups, hasMultipleEnvironments };
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

  const renderRow = (thread: ArchivedThread) => {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    return (
      <SettingsRow
        key={`${thread.environmentId}:${thread.id}`}
        className="rounded-none"
        onContextMenu={(event) => {
          event.preventDefault();
          void handleContextMenu(thread, { x: event.clientX, y: event.clientY });
        }}
        title={thread.title}
        description={
          <span className={hasMultipleEnvironments ? "block truncate" : undefined}>
            {hasMultipleEnvironments ? `${thread.environmentLabel} · ` : null}
            <T>
              Archived <RelativeTime timestamp={thread.archivedAt ?? thread.createdAt} />
              {" \u00b7 Created "}
              <RelativeTime timestamp={thread.createdAt} />
            </T>
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
                      variant={action === "delete" ? "destructive-outline" : "outline"}
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
  };

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive").id}
          title={searchableSetting("archive").title}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <Spinner size="sm" tone="muted" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? gt("Loading archived threads")
                  : archiveError
                    ? gt("Could not load archived threads")
                    : gt("No archived threads")}
              </span>
            }
            description={
              isLoadingArchive
                ? gt("Checking connected environments.")
                : (archiveError ?? gt("Archived threads will appear here."))
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ key, project, title, firstRow, threads: projectThreads }, index) => (
          <SettingsSection
            key={key}
            id={index === 0 ? searchableSetting("archive").id : undefined}
            title={title}
            icon={<ProjectFavicon project={project} />}
          >
            {Array.from(
              { length: Math.ceil(projectThreads.length / ARCHIVED_ROW_CHUNK_SIZE) },
              (_, chunkIndex) => {
                const start = chunkIndex * ARCHIVED_ROW_CHUNK_SIZE;
                const rows = projectThreads.slice(start, start + ARCHIVED_ROW_CHUNK_SIZE);
                return (
                  <ArchivedThreadChunk
                    key={chunkIndex}
                    rowCount={rows.length}
                    initiallyMounted={firstRow + start < ARCHIVED_ROW_CHUNK_SIZE}
                    renderRows={() => rows.map(renderRow)}
                  />
                );
              },
            )}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
