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
import { FolderGitIcon, PinOffIcon, PlusIcon } from "lucide-react";
import { msg, T, useGT } from "gt-react";
import { memo, useRef, useState } from "react";

import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { useQuietThreadProjection } from "~/state/entities";
import { filesystemEnvironment, useFilesystemReadAccess } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { useThreadRepositoryPins, useThreadRepositoryPinsStore } from "~/threadRepositoryPinsStore";

import { GitActionsControl } from "../GitActionsControl";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
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
}

const RepositorySection = memo(function RepositorySection(props: {
  threadRef: ScopedThreadRef;
  sectionKey: string;
  name: string;
  cwd: string;
  removable: boolean;
  overflow: boolean;
  owner: { readonly threadId?: ThreadId; readonly projectId?: ProjectId };
  showActions: boolean;
  onRemove: (key: string) => void;
  onRowElement: (key: string, element: HTMLButtonElement | null) => void;
}) {
  // Local status only: a remote read for every listed repository would fetch on a timer. Opening
  // the row's actions menu refreshes remote status on demand, and updates land here too.
  const status = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId: props.threadRef.environmentId,
      input: { cwd: props.cwd, includeRemote: false },
    }),
  );
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const summary = repositorySectionSummary(status.data);
  const ignoreNextRowClickRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const gt = useGT();

  const subtitle =
    summary === null
      ? (status.error ?? "")
      : !summary.isRepository
        ? gt("Not a Git repository")
        : (summary.branch ?? gt("Detached HEAD"));
  const hasDiff = summary?.isRepository === true && summary.changedFiles > 0;
  const hasPr = summary?.isRepository === true && summary.pullRequest !== null;
  const hasMenu = props.showActions || props.removable;
  const rowAriaLabel = [
    props.name,
    subtitle,
    hasPr && summary?.pullRequest ? `#${summary.pullRequest.number}` : null,
    hasDiff && summary
      ? `+${formatDiffCount(summary.insertions)} -${formatDiffCount(summary.deletions)}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      role="group"
      aria-label={gt("Repository {name}", { name: props.name })}
      data-thread-details-repository-overflow={props.overflow || undefined}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center"
    >
      <Tooltip>
        <TooltipTrigger
          delay={300}
          render={
            <ThreadDetailsControl
              ref={(element) => props.onRowElement(props.sectionKey, element)}
              size="sm"
              variant="ghost"
              part="row"
              multiline
              aria-label={rowAriaLabel}
              aria-haspopup={hasMenu ? "menu" : undefined}
              aria-expanded={hasMenu ? menuOpen : undefined}
              onPointerDown={() => {
                if (menuOpen) ignoreNextRowClickRef.current = true;
              }}
              onClick={() => {
                if (ignoreNextRowClickRef.current) {
                  ignoreNextRowClickRef.current = false;
                  return;
                }
                if (!hasMenu) return;
                const next = !menuOpen;
                setMenuOpen(next);
                if (next && summary?.isRepository && props.showActions) {
                  void refreshVcsStatus({
                    environmentId: props.threadRef.environmentId,
                    input: { cwd: props.cwd },
                  });
                }
              }}
            />
          }
        >
          <FolderGitIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-1.5 leading-4">
              <span className="min-w-0 flex-1 truncate">{props.name}</span>
              {hasDiff && summary ? (
                <span className="flex shrink-0 items-baseline gap-1.5 font-mono tabular-nums">
                  <span
                    className={
                      summary.insertions > 0 ? "text-diff-addition" : "text-muted-foreground"
                    }
                  >
                    +{formatDiffCount(summary.insertions)}
                  </span>
                  <span
                    className={
                      summary.deletions > 0 ? "text-diff-deletion" : "text-muted-foreground"
                    }
                  >
                    -{formatDiffCount(summary.deletions)}
                  </span>
                </span>
              ) : null}
            </span>
            {subtitle || hasPr ? (
              <span className="flex min-w-0 items-baseline gap-1.5 leading-4 text-muted-foreground">
                <span className="min-w-0 truncate">{subtitle}</span>
                {hasPr && summary?.pullRequest ? (
                  <span className="ms-auto shrink-0 tabular-nums">
                    #{summary.pullRequest.number}
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left">
          <span className="block">{props.name}</span>
          {subtitle ? <span className="block text-muted-foreground">{subtitle}</span> : null}
        </TooltipPopup>
      </Tooltip>
      {hasMenu ? (
        <GitActionsControl
          displayMode="panel"
          compactNonRepo
          includeRemote={false}
          target={{ key: props.sectionKey, cwd: props.cwd, name: props.name }}
          threadRef={props.threadRef}
          owner={props.owner}
          showActions={props.showActions}
          showChanges={false}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
          menuFooter={
            props.removable ? (
              <MenuItem onClick={() => props.onRemove(props.sectionKey)}>
                <PinOffIcon />
                <MenuItemLabel>
                  <T>Remove from this thread</T>
                </MenuItemLabel>
              </MenuItem>
            ) : undefined
          }
        />
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
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const pickedKeyRef = useRef<string | null>(null);
  const pendingMountFocusKeyRef = useRef<string | null>(null);
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
      if (pendingMountFocusKeyRef.current === repository.repositoryPath) {
        pendingMountFocusKeyRef.current = null;
      }
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
  };
  const owner = props.isServerThread
    ? { threadId: props.threadId }
    : { projectId: props.projectId };
  const remove = (key: string) => unpin(threadRef, key);
  const handleRowElement = (key: string, element: HTMLButtonElement | null) => {
    if (element) {
      rowRefs.current.set(key, element);
      if (pendingMountFocusKeyRef.current === key) {
        pendingMountFocusKeyRef.current = null;
        element.focus({ preventScroll: true });
      }
    } else {
      rowRefs.current.delete(key);
    }
  };
  const renderSection = (section: ThreadRepositorySection, index: number) => (
    <RepositorySection
      key={section.key}
      threadRef={threadRef}
      sectionKey={section.key}
      name={section.name}
      cwd={section.cwd}
      removable={section.origin === "pinned"}
      overflow={index >= THREAD_REPOSITORY_SECTIONS_VISIBLE}
      owner={owner}
      showActions={props.showActions}
      onRemove={remove}
      onRowElement={handleRowElement}
    />
  );

  const offersPicker =
    props.reachesTracked &&
    canReadFiles &&
    (taskFolder === null || (props.isServerThread && canAddWorktree));

  return (
    <>
      {sections.visible.length === 0 &&
      props.explainsEmpty &&
      props.reachesTracked &&
      !offersPicker ? (
        <p className="px-2.5 py-1.5 text-meta text-muted-foreground">
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
      {offersPicker ? (
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
          <MenuPopup
            align="start"
            finalFocus={() => {
              const key = pickedKeyRef.current;
              if (key === null) return true;
              pickedKeyRef.current = null;
              const row = rowRefs.current.get(key);
              if (row) return row;
              pendingMountFocusKeyRef.current = key;
              return false;
            }}
          >
            {isPickerOpen ? (
              <OtherRepositoryItems
                environmentId={props.environmentId}
                projectId={props.projectId}
                threadCwd={props.threadCwd}
                taskFolder={taskFolder}
                sections={sections}
                onPick={(repository) => {
                  pickedKeyRef.current = repository.repositoryPath;
                  if (taskFolder !== null) {
                    void addWorktree(repository);
                    return;
                  }
                  pin(threadRef, repository);
                  // Pins beyond the visible few would land folded away, out of sight.
                  if (pinned.length >= THREAD_REPOSITORY_SECTIONS_VISIBLE) setShowAll(true);
                }}
              />
            ) : null}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
}
