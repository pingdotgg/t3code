import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId, ThreadId, ThreadRepoWorktree } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useGT } from "gt-react-native";

import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { Menu } from "../../../components/ui/Menu";
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
  /** What Git actions use when no repository worktree is selected. */
  readonly workspace: "thread-worktree" | "project-folder";
  readonly onSelect: (worktreePath: string | null) => void;
}) {
  const gt = useGT();
  const repoWorktrees = useAtomValue(
    environmentThreadDetails.repoWorktreesAtom({
      environmentId: props.environmentId,
      threadId: props.threadId,
    }),
  );
  const detach = useAtomCommand(threadEnvironment.detachRepoWorktree, { reportFailure: true });
  if (repoWorktrees.length === 0) return null;

  const menuActions = (entry: ThreadRepoWorktree): MenuAction[] => [
    props.selected?.worktreePath === entry.worktreePath
      ? {
          id: "use-workspace",
          title:
            props.workspace === "thread-worktree"
              ? gt("Use thread worktree for Git")
              : gt("Use project folder for Git"),
        }
      : { id: "use-worktree", title: gt("Use for Git and changes") },
    { id: "copy-path", title: gt("Copy path") },
    { id: "detach", title: gt("Detach from thread"), attributes: { destructive: true } },
  ];
  const onMenuAction = (entry: ThreadRepoWorktree, action: string) => {
    if (action === "use-workspace") props.onSelect(null);
    else if (action === "use-worktree") props.onSelect(entry.worktreePath);
    else if (action === "copy-path") void Clipboard.setStringAsync(entry.worktreePath);
    else if (action === "detach") {
      void detach({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, worktreePath: entry.worktreePath },
      });
    }
  };

  return (
    <ListSection
      title={gt("Repository worktrees")}
      footer={
        props.selected !== null
          ? gt(
              "Turn diffs and rollback include these. Rollback restores no files while another thread also works in one.",
            )
          : props.workspace === "thread-worktree"
            ? gt(
                "Git and changes above use the thread worktree. Turn diffs and rollback include these. Rollback restores no files while another thread also works in one.",
              )
            : gt(
                "Git and changes above use the project folder. Turn diffs and rollback include these. Rollback restores no files while another thread also works in one.",
              )
      }
    >
      {repoWorktrees.map((entry) => (
        <Menu
          key={entry.worktreePath}
          title={`${entry.repository} · ${entry.branch}`}
          actions={menuActions(entry)}
          onPressAction={({ nativeEvent }) => onMenuAction(entry, nativeEvent.event)}
        >
          <ListRow
            icon="folder"
            label={`${entry.repository} · ${entry.branch}`}
            description={
              props.selected?.worktreePath === entry.worktreePath
                ? gt("Git and changes above · {path}", { path: entry.worktreePath })
                : entry.worktreePath
            }
            // The menu opens on tap.
            onPress={() => {}}
          />
        </Menu>
      ))}
    </ListSection>
  );
}
