import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  addableTaskFolderRepositories,
  pinnableThreadRepositories,
  repositorySectionSummary,
  THREAD_REPOSITORY_SECTIONS_VISIBLE,
  threadChangedRepositories,
  threadRepositorySections,
  type PinnedThreadRepository,
  type RepositorySectionSummary,
  type ThreadRepositorySection,
  type ThreadRepositorySections,
} from "@t3tools/client-runtime/state/thread-repositories";
import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type TaskFolder,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { memo, useState } from "react";

import { AppText as Text } from "../../../components/ui/AppText";
import * as Dialog from "../../../components/ui/Dialog";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import type { MessageResolver } from "../../../i18n/messages";
import { filesystemEnvironment } from "../../../state/filesystem";
import { useEnvironmentQuery } from "../../../state/query";
import { useEnvironmentScope } from "../../../state/session";
import {
  pinRepositoryToThread,
  useThreadRepositoryPins,
} from "../../../state/thread-repository-pins";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useQuietThreadStructure } from "../../../state/use-thread-detail";
import { vcsEnvironment } from "../../../state/vcs";

function repositoryRowDescription(
  summary: RepositorySectionSummary | null,
  error: string | null,
  resolve: MessageResolver,
): string {
  if (summary === null) return error ?? resolve(msg("Checking status"));
  if (!summary.isRepository) return resolve(msg("Not a Git repository"));
  const branch = summary.branch ?? resolve(msg("Detached HEAD"));
  if (summary.changedFiles === 0) return resolve(msg("{branch} · Clean", { branch }));
  return resolve(
    msg(
      "{branch} · {count, plural, one {{count} file} other {{count} files}} · +{insertions} −{deletions}",
      {
        branch,
        count: summary.changedFiles,
        insertions: formatDiffCount(summary.insertions),
        deletions: formatDiffCount(summary.deletions),
      },
    ),
  );
}

const RepositoryRow = memo(function RepositoryRow(props: {
  readonly environmentId: EnvironmentId;
  readonly section: ThreadRepositorySection;
  readonly onOpen: (section: ThreadRepositorySection) => void;
}) {
  // Local status only: a remote read for every listed repository would fetch on a timer. The
  // repository opened for actions holds the full subscription, and its remote updates land here.
  const status = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId: props.environmentId,
      input: { cwd: props.section.cwd, includeRemote: false },
    }),
  );
  const summary = repositorySectionSummary(status.data);
  const resolve = useMessages();
  return (
    <ListRow
      icon="folder"
      label={props.section.name}
      description={repositoryRowDescription(summary, status.error, resolve)}
      detail={
        summary?.isRepository && summary.pullRequest ? `#${summary.pullRequest.number}` : undefined
      }
      onPress={() => props.onOpen(props.section)}
    />
  );
});

/** Mounted while the picker is open, so the folder list is read only when someone asks for it. */
function OtherRepositoryRows(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadCwd: string | null;
  readonly taskFolder: TaskFolder | null;
  readonly sections: ThreadRepositorySections;
  readonly onPick: (repository: PinnedThreadRepository) => void;
}) {
  const gt = useGT();
  const folders = useEnvironmentQuery(
    filesystemEnvironment.listFolders({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  if (folders.data === null) {
    return (
      <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
        {folders.error ?? gt("Loading repositories…")}
      </Text>
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
      <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
        <T>No other repositories</T>
      </Text>
    );
  }
  return repositories.map((repository) => (
    <ListRow
      key={repository.repositoryPath}
      icon="plus"
      label={repository.name}
      onPress={() => props.onPick(repository)}
    />
  ));
}

/**
 * The tracked repositories a thread changed or the user added, or the worktrees in its task
 * folder. Folded rows are not rendered, so they hold no subscription.
 */
export function ThreadRepositoryRows(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  /** The thread's own folder, which has its own Git controls when it is a repository. */
  readonly threadCwd: string | null;
  /**
   * The thread's task folder. Its repositories are then the only ones listed, each bound to the
   * thread's own worktree of it, and adding one creates that worktree.
   */
  readonly taskFolder: TaskFolder | null;
  /** False when the thread reaches no tracked repository: it lists only what it changed. */
  readonly reachesTracked: boolean;
  readonly onTaskFolderChange: () => void;
  /** Says so when no repository is listed, instead of leaving the section blank. */
  readonly explainsEmpty: boolean;
  readonly onOpen: (section: ThreadRepositorySection) => void;
}) {
  const { threadRef, taskFolder } = props;
  const gt = useGT();
  const structure = useQuietThreadStructure(threadRef);
  const pinned = useThreadRepositoryPins(threadRef);
  const canReadFiles = useEnvironmentScope(threadRef.environmentId, AuthFilesystemReadScope);
  const [showAll, setShowAll] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const canAddWorktree = useAtomValue(
    filesystemEnvironment.addTaskFolderRepository.permissionAtom(threadRef.environmentId),
  );
  const addTaskFolderRepository = useAtomCommand(filesystemEnvironment.addTaskFolderRepository, {
    reportFailure: false,
  });
  const [addingName, setAddingName] = useState<string | null>(null);

  const sections = threadRepositorySections({
    changed: structure === null ? [] : threadChangedRepositories(structure.projection),
    pinned,
    threadCwd: props.threadCwd,
    showAll,
    taskFolder,
    reachesTracked: props.reachesTracked,
  });
  const addWorktree = async (repository: PinnedThreadRepository) => {
    if (addingName !== null) return;
    setAddingName(repository.name);
    setIsPickerOpen(false);
    const result = await addTaskFolderRepository({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, repositoryPath: repository.repositoryPath },
    });
    setAddingName(null);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        gt("Could not add {name}", { name: repository.name }),
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    props.onTaskFolderChange();
    setShowAll(true);
  };
  const offersPicker =
    props.reachesTracked && canReadFiles && (taskFolder === null || canAddWorktree);
  const explainsEmpty =
    sections.visible.length === 0 && props.explainsEmpty && props.reachesTracked;
  if (sections.visible.length === 0 && !explainsEmpty && !offersPicker) return null;
  const foldable =
    sections.hidden.length > 0 ||
    (showAll && sections.visible.length > THREAD_REPOSITORY_SECTIONS_VISIBLE);

  return (
    <ListSection title={gt("Repositories")}>
      {explainsEmpty ? (
        <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
          {taskFolder === null
            ? gt("Repositories appear here once this thread changes them.")
            : gt("This thread has no repository worktrees yet.")}
        </Text>
      ) : null}
      {sections.visible.map((section) => (
        <RepositoryRow
          key={section.key}
          environmentId={threadRef.environmentId}
          section={section}
          onOpen={props.onOpen}
        />
      ))}
      {foldable ? (
        <ListRow
          icon={showAll ? "chevron.up" : "chevron.down"}
          label={
            showAll ? gt("Show fewer") : gt("Show {count} more", { count: sections.hidden.length })
          }
          onPress={() => setShowAll((current) => !current)}
        />
      ) : null}
      {offersPicker ? (
        <ListRow
          icon="folder.badge.plus"
          label={
            addingName === null
              ? gt("Other repositories…")
              : gt("Adding a worktree of {name}…", { name: addingName })
          }
          description={
            isPickerOpen || addingName !== null
              ? undefined
              : taskFolder === null
                ? gt("Add a tracked repository to this thread")
                : gt("Add a worktree of a tracked repository")
          }
          disabled={addingName !== null}
          onPress={() => setIsPickerOpen((current) => !current)}
        />
      ) : null}
      {offersPicker && isPickerOpen ? (
        <OtherRepositoryRows
          environmentId={threadRef.environmentId}
          projectId={props.projectId}
          threadCwd={props.threadCwd}
          taskFolder={taskFolder}
          sections={sections}
          onPick={(repository) => {
            if (taskFolder !== null) {
              void addWorktree(repository);
              return;
            }
            pinRepositoryToThread(threadRef, repository);
            // Pins beyond the visible few would land folded away, out of sight.
            if (pinned.length >= THREAD_REPOSITORY_SECTIONS_VISIBLE) setShowAll(true);
            setIsPickerOpen(false);
          }}
        />
      ) : null}
    </ListSection>
  );
}
