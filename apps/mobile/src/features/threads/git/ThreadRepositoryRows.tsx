import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import {
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
} from "@t3tools/contracts";
import { memo, useState } from "react";

import { AppText as Text } from "../../../components/ui/AppText";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { filesystemEnvironment } from "../../../state/filesystem";
import { useEnvironmentQuery } from "../../../state/query";
import { useEnvironmentScope } from "../../../state/session";
import {
  pinRepositoryToThread,
  useThreadRepositoryPins,
} from "../../../state/thread-repository-pins";
import { useQuietThreadStructure } from "../../../state/use-thread-detail";
import { vcsEnvironment } from "../../../state/vcs";

function repositoryRowDescription(
  summary: RepositorySectionSummary | null,
  error: string | null,
): string {
  if (summary === null) return error ?? "Checking status";
  if (!summary.isRepository) return "Not a Git repository";
  const branch = summary.branch ?? "Detached HEAD";
  if (summary.changedFiles === 0) return `${branch} · Clean`;
  const files = `${summary.changedFiles} file${summary.changedFiles === 1 ? "" : "s"}`;
  return `${branch} · ${files} · +${formatDiffCount(summary.insertions)} −${formatDiffCount(summary.deletions)}`;
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
  return (
    <ListRow
      icon="folder"
      label={props.section.name}
      description={repositoryRowDescription(summary, status.error)}
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
  readonly sections: ThreadRepositorySections;
  readonly onPick: (repository: PinnedThreadRepository) => void;
}) {
  const folders = useEnvironmentQuery(
    filesystemEnvironment.listFolders({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  if (folders.data === null) {
    return (
      <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
        {folders.error ?? "Loading repositories…"}
      </Text>
    );
  }
  const repositories = pinnableThreadRepositories({
    folders: folders.data.folders,
    sections: props.sections,
    threadCwd: props.threadCwd,
  });
  if (repositories.length === 0) {
    return (
      <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
        No other repositories
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
 * The tracked repositories a thread changed or the user added. Folded rows are not rendered, so
 * they hold no subscription.
 */
export function ThreadRepositoryRows(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  /** The thread's own folder, which has its own Git controls when it is a repository. */
  readonly threadCwd: string | null;
  /** Says so when no repository is listed, instead of leaving the section blank. */
  readonly explainsEmpty: boolean;
  readonly onOpen: (section: ThreadRepositorySection) => void;
}) {
  const { threadRef } = props;
  const structure = useQuietThreadStructure(threadRef);
  const pinned = useThreadRepositoryPins(threadRef);
  const canReadFiles = useEnvironmentScope(threadRef.environmentId, AuthFilesystemReadScope);
  const [showAll, setShowAll] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  const sections = threadRepositorySections({
    changed: structure === null ? [] : threadChangedRepositories(structure.projection),
    pinned,
    threadCwd: props.threadCwd,
    showAll,
  });
  const explainsEmpty = sections.visible.length === 0 && props.explainsEmpty;
  if (sections.visible.length === 0 && !explainsEmpty && !canReadFiles) return null;
  const foldable =
    sections.hidden.length > 0 ||
    (showAll && sections.visible.length > THREAD_REPOSITORY_SECTIONS_VISIBLE);

  return (
    <ListSection title="Repositories">
      {explainsEmpty ? (
        <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
          Repositories appear here once this thread changes them.
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
          label={showAll ? "Show fewer" : `Show ${sections.hidden.length} more`}
          onPress={() => setShowAll((current) => !current)}
        />
      ) : null}
      {canReadFiles ? (
        <ListRow
          icon="folder.badge.plus"
          label="Other repositories…"
          description={isPickerOpen ? undefined : "Add a tracked repository to this thread"}
          onPress={() => setIsPickerOpen((current) => !current)}
        />
      ) : null}
      {canReadFiles && isPickerOpen ? (
        <OtherRepositoryRows
          environmentId={threadRef.environmentId}
          projectId={props.projectId}
          threadCwd={props.threadCwd}
          sections={sections}
          onPick={(repository) => {
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
