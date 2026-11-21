import {
  addableTaskFolderRepositories,
  pinnableThreadRepositories,
  repositorySectionSummary,
  THREAD_REPOSITORY_SECTIONS_VISIBLE,
  threadChangedRepositories,
  threadRepositorySections,
  type ThreadRepositorySection,
  type ThreadRepositorySections as RepositorySections,
} from "@t3tools/client-runtime/state/thread-repositories";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  TaskFolder,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGitIcon,
  PinOffIcon,
  PlusIcon,
} from "lucide-react";
import { msg, T, useGT } from "gt-react";
import { memo, useState } from "react";

import { m } from "~/i18n/messages";
import { selectRepositoryBranchBaseRef, useDiffPanelStore } from "~/diffPanelStore";
import { cn } from "~/lib/utils";
import { useQuietThreadProjection } from "~/state/entities";
import { filesystemEnvironment, useFilesystemReadAccess } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { useThreadRepositoryPins, useThreadRepositoryPinsStore } from "~/threadRepositoryPinsStore";

import { GitActionsControl } from "../GitActionsControl";
import { resolveChangesTotals } from "../GitActionsControl.logic";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

interface ThreadRepositorySectionsProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  isServerThread: boolean;
  /** The thread's own folder, which has its own Git controls when it is a repository. */
  threadCwd: string | null;
  /**
   * The thread's task folder. Its repositories are then the only ones listed, each bound to the
   * thread's own worktree of it, and adding one creates that worktree.
   */
  taskFolder: TaskFolder | null;
  /** False when the thread reaches no tracked repository: it lists only what it changed. */
  reachesTracked: boolean;
  onTaskFolderChange: () => void;
  /** Says so when no repository is listed, instead of leaving the section blank. */
  explainsEmpty: boolean;
  showActions: boolean;
  showChanges: boolean;
  /** Opens the Diff panel on the repository at this path. */
  onOpenChanges?: (repositoryPath: string) => void;
}

const RepositorySection = memo(function RepositorySection(props: {
  threadRef: ScopedThreadRef;
  sectionKey: string;
  name: string;
  cwd: string;
  removable: boolean;
  expanded: boolean;
  owner: { readonly threadId?: ThreadId; readonly projectId?: ProjectId };
  showActions: boolean;
  showChanges: boolean;
  onOpenChanges: ((repositoryPath: string) => void) | undefined;
  onToggle: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  // Local status only: a remote read for every listed repository would fetch on a timer. The
  // expanded section's actions hold the full subscription, and its remote updates land here too.
  const status = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId: props.threadRef.environmentId,
      input: { cwd: props.cwd, includeRemote: false, includeBranchChanges: true },
    }),
  );
  const summary = repositorySectionSummary(status.data);
  // Against the branch's base, as the Changes row counts, so unpushed commits show too.
  const totals = resolveChangesTotals(status.data);
  const changesBaseRef = useDiffPanelStore((state) =>
    selectRepositoryBranchBaseRef(state, props.threadRef, props.sectionKey),
  );
  const Chevron = props.expanded ? ChevronDownIcon : ChevronRightIcon;
  const bodyId = `thread-repository-${props.sectionKey}`;
  const gt = useGT();

  return (
    <div
      role="group"
      aria-label={gt("Repository {name}", { name: props.name })}
      className="flex flex-col"
    >
      <ThreadDetailsControl
        size="sm"
        variant="ghost"
        part="row"
        aria-expanded={props.expanded}
        aria-controls={props.expanded ? bodyId : undefined}
        onClick={() => props.onToggle(props.sectionKey)}
      >
        <Chevron className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} aria-hidden />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="max-w-2/3 shrink-0 truncate">{props.name}</span>
          <span className="min-w-0 truncate font-normal text-muted-foreground">
            {summary === null
              ? (status.error ?? "")
              : !summary.isRepository
                ? gt("Not a Git repository")
                : (summary.branch ?? gt("Detached HEAD"))}
          </span>
          {summary?.isRepository ? (
            <span className="ml-auto flex shrink-0 items-baseline gap-2 ps-2 font-mono tabular-nums">
              {summary.pullRequest ? (
                <span className="font-sans font-normal text-muted-foreground">
                  #{summary.pullRequest.number}
                </span>
              ) : null}
              {totals &&
              (totals.insertions > 0 || totals.deletions > 0 || summary.changedFiles > 0) ? (
                <>
                  <span className="text-diff-addition-foreground">
                    +{formatDiffCount(totals.insertions)}
                  </span>
                  <span className="text-diff-deletion-foreground">
                    -{formatDiffCount(totals.deletions)}
                  </span>
                </>
              ) : null}
            </span>
          ) : null}
        </span>
      </ThreadDetailsControl>
      {props.expanded ? (
        <div id={bodyId} className="flex flex-col ps-4">
          <GitActionsControl
            target={{ key: props.sectionKey, cwd: props.cwd, name: props.name }}
            threadRef={props.threadRef}
            owner={props.owner}
            showActions={props.showActions}
            showChanges={props.showChanges}
            changesBaseRef={changesBaseRef}
            {...(props.onOpenChanges
              ? { onOpenChanges: () => props.onOpenChanges?.(props.sectionKey) }
              : {})}
          />
          {props.removable ? (
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              tone="muted"
              onClick={() => props.onRemove(props.sectionKey)}
            >
              <PinOffIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
              <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>
                <T>Remove from this thread</T>
              </span>
            </ThreadDetailsControl>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/** Mounted while the menu is open, so the folder list is read only when someone asks for it. */
function OtherRepositoryItems(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadCwd: string | null;
  taskFolder: TaskFolder | null;
  sections: RepositorySections;
  onPick: (repository: { repositoryPath: string; name: string }) => void;
}) {
  const folders = useEnvironmentQuery(
    filesystemEnvironment.listFolders({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const gt = useGT();
  if (folders.data === null) {
    return (
      <MenuItem disabled>
        <MenuItemLabel>{folders.error ?? gt("Loading repositories...")}</MenuItemLabel>
      </MenuItem>
    );
  }
  const repositories =
    props.taskFolder === null
      ? pinnableThreadRepositories({
          folders: folders.data.folders,
          sections: props.sections,
          threadCwd: props.threadCwd,
        })
      : addableTaskFolderRepositories({
          folders: folders.data.folders,
          taskFolder: props.taskFolder,
        });
  if (repositories.length === 0) {
    return (
      <MenuItem disabled>
        <MenuItemLabel>
          <T>No other repositories</T>
        </MenuItemLabel>
      </MenuItem>
    );
  }
  return repositories.map((repository) => (
    <MenuItem key={repository.repositoryPath} onClick={() => props.onPick(repository)}>
      <FolderGitIcon />
      <MenuItemLabel>{repository.name}</MenuItemLabel>
    </MenuItem>
  ));
}

/**
 * Git state and actions for the tracked repositories a thread changed or the user added, or for
 * the worktrees in its task folder. Folded sections are not rendered, so they hold no subscription.
 */
export function ThreadRepositorySections(props: ThreadRepositorySectionsProps) {
  const threadRef: ScopedThreadRef = {
    environmentId: props.environmentId,
    threadId: props.threadId,
  };
  const structure = useQuietThreadProjection(props.isServerThread ? threadRef : null);
  const pinned = useThreadRepositoryPins(threadRef);
  const pin = useThreadRepositoryPinsStore((state) => state.pin);
  const unpin = useThreadRepositoryPinsStore((state) => state.unpin);
  const { canReadFiles } = useFilesystemReadAccess(props.environmentId);
  const [showAll, setShowAll] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const canAddWorktree = useAtomValue(
    filesystemEnvironment.addTaskFolderRepository.permissionAtom(props.environmentId),
  );
  const addTaskFolderRepository = useAtomCommand(filesystemEnvironment.addTaskFolderRepository, {
    label: "task folder add repository",
    reportFailure: false,
  });
  const [addingName, setAddingName] = useState<string | null>(null);
  const gt = useGT();

  const { taskFolder } = props;
  const sections = threadRepositorySections({
    changed: structure === null ? [] : threadChangedRepositories(structure.projection),
    pinned,
    threadCwd: props.threadCwd,
    showAll,
    taskFolder,
    reachesTracked: props.reachesTracked,
  });
  const addWorktree = async (repository: { repositoryPath: string; name: string }) => {
    if (addingName !== null) return;
    setAddingName(repository.name);
    const result = await addTaskFolderRepository({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, repositoryPath: repository.repositoryPath },
    });
    setAddingName(null);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not add {name}", { name: repository.name })),
          description: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    props.onTaskFolderChange();
    setShowAll(true);
    setExpandedKey(repository.repositoryPath);
  };
  const owner = props.isServerThread
    ? { threadId: props.threadId }
    : { projectId: props.projectId };
  const toggle = (key: string) => setExpandedKey((current) => (current === key ? null : key));
  const remove = (key: string) => unpin(threadRef, key);
  const renderSection = (section: ThreadRepositorySection) => (
    <RepositorySection
      key={section.key}
      threadRef={threadRef}
      sectionKey={section.key}
      name={section.name}
      cwd={section.cwd}
      removable={section.origin === "pinned"}
      expanded={expandedKey === section.key}
      owner={owner}
      showActions={props.showActions}
      showChanges={props.showChanges}
      onOpenChanges={props.onOpenChanges}
      onToggle={toggle}
      onRemove={remove}
    />
  );

  return (
    <>
      {sections.visible.length === 0 && props.explainsEmpty && props.reachesTracked ? (
        <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
          {taskFolder === null
            ? gt("Repositories appear here once this thread changes them.")
            : gt("This thread has no repository worktrees yet.")}
        </p>
      ) : null}
      {sections.visible.map(renderSection)}
      {sections.hidden.length > 0 ||
      (showAll && sections.visible.length > THREAD_REPOSITORY_SECTIONS_VISIBLE) ? (
        <ThreadDetailsControl
          size="sm"
          variant="ghost"
          part="row"
          tone="muted"
          aria-expanded={showAll}
          onClick={() => setShowAll((current) => !current)}
        >
          <span className={cn("ms-6.5", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            {showAll
              ? gt("Show fewer")
              : gt("Show {count} more", { count: sections.hidden.length })}
          </span>
        </ThreadDetailsControl>
      ) : null}
      {props.reachesTracked &&
      canReadFiles &&
      (taskFolder === null || (props.isServerThread && canAddWorktree)) ? (
        <Menu open={isPickerOpen} onOpenChange={setIsPickerOpen}>
          <MenuTrigger
            render={<ThreadDetailsControl size="sm" variant="ghost" part="row" tone="muted" />}
            disabled={addingName !== null}
          >
            <PlusIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>
              {addingName === null
                ? gt("Other repositories...")
                : gt("Adding a worktree of {name}...", { name: addingName })}
            </span>
          </MenuTrigger>
          <MenuPopup align="start">
            {isPickerOpen ? (
              <OtherRepositoryItems
                environmentId={props.environmentId}
                projectId={props.projectId}
                threadCwd={props.threadCwd}
                taskFolder={taskFolder}
                sections={sections}
                onPick={(repository) => {
                  if (taskFolder !== null) {
                    void addWorktree(repository);
                    return;
                  }
                  pin(threadRef, repository);
                  // Pins beyond the visible few would land folded away, out of sight.
                  if (pinned.length >= THREAD_REPOSITORY_SECTIONS_VISIBLE) setShowAll(true);
                  setExpandedKey(repository.repositoryPath);
                }}
              />
            ) : null}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
}
