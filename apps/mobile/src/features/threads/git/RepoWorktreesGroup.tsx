import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId, ThreadRepoWorktree } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";

import * as Dialog from "../../../components/ui/Dialog";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { environmentThreadDetails, threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";

/**
 * Where this thread's work lives when its project holds several repositories,
 * and which one the Git actions and changes above use.
 */
export function RepoWorktreesGroup(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly selected: ThreadRepoWorktree | null;
  readonly workspaceLabel: string;
  readonly onSelect: (worktreePath: string | null) => void;
}) {
  const repoWorktrees = useAtomValue(
    environmentThreadDetails.repoWorktreesAtom({
      environmentId: props.environmentId,
      threadId: props.threadId,
    }),
  );
  const detach = useAtomCommand(threadEnvironment.detachRepoWorktree, { reportFailure: true });
  if (repoWorktrees.length === 0) return null;

  const showActions = (entry: ThreadRepoWorktree) => {
    const isSelected = props.selected?.worktreePath === entry.worktreePath;
    Dialog.alert(`${entry.repository} · ${entry.branch}`, entry.worktreePath, [
      isSelected
        ? {
            text: `Use ${props.workspaceLabel.toLowerCase()} for Git`,
            onPress: () => props.onSelect(null),
          }
        : { text: "Use for Git and changes", onPress: () => props.onSelect(entry.worktreePath) },
      { text: "Copy path", onPress: () => void Clipboard.setStringAsync(entry.worktreePath) },
      {
        text: "Detach from thread",
        style: "destructive",
        onPress: () =>
          void detach({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, worktreePath: entry.worktreePath },
          }),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  return (
    <ListSection
      title="Repository worktrees"
      footer={`${
        props.selected === null
          ? `Git and changes above use the ${props.workspaceLabel.toLowerCase()}. `
          : ""
      }Turn diffs and rollback include these. Rollback restores no files while another thread also works in one.`}
    >
      {repoWorktrees.map((entry) => (
        <ListRow
          key={entry.worktreePath}
          icon="folder"
          label={`${entry.repository} · ${entry.branch}`}
          description={
            props.selected?.worktreePath === entry.worktreePath
              ? `Git and changes above · ${entry.worktreePath}`
              : entry.worktreePath
          }
          onPress={() => showActions(entry)}
        />
      ))}
    </ListSection>
  );
}
