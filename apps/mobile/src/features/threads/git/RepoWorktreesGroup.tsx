import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId, ThreadId, ThreadRepoWorktree } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";

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

  const menuActions = (entry: ThreadRepoWorktree): MenuAction[] => [
    props.selected?.worktreePath === entry.worktreePath
      ? { id: "use-workspace", title: `Use ${props.workspaceLabel.toLowerCase()} for Git` }
      : { id: "use-worktree", title: "Use for Git and changes" },
    { id: "copy-path", title: "Copy path" },
    { id: "detach", title: "Detach from thread", attributes: { destructive: true } },
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
      title="Repository worktrees"
      footer={`${
        props.selected === null
          ? `Git and changes above use the ${props.workspaceLabel.toLowerCase()}. `
          : ""
      }Turn diffs and rollback include these. Rollback restores no files while another thread also works in one.`}
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
                ? `Git and changes above · ${entry.worktreePath}`
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
