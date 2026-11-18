import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId, ThreadRepoWorktree } from "@t3tools/contracts";
import { msg, T, useGT } from "gt-react";
import { CopyIcon, FileDiffIcon, FolderGit2Icon, UnlinkIcon } from "lucide-react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { environmentThreadDetails, threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

/** Where this thread's work lives when its project holds several repositories. */
export function ThreadRepoWorktreesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Makes the worktree the thread's Changes and Git target, then shows its changes. */
  readonly onShowChanges?: (worktreePath: string) => void;
}) {
  const gt = useGT();
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const repoWorktrees = useAtomValue(environmentThreadDetails.repoWorktreesAtom(ref));
  const detach = useAtomCommand(threadEnvironment.detachRepoWorktree, { reportFailure: true });
  if (repoWorktrees.length === 0) return null;

  const copyPath = (entry: ThreadRepoWorktree) =>
    void writeTextToClipboard(entry.worktreePath, {
      target: "worktree path",
      unavailableMessage: msg("Clipboard API is unavailable while copying worktree path."),
      failureMessage: msg("Failed to copy worktree path to the clipboard."),
    }).then((copied) => {
      if (copied) {
        toastManager.add({
          type: "success",
          title: gt("Path copied"),
          description: entry.worktreePath,
        });
      }
    });

  return (
    <ThreadDetailsSection
      headingId="thread-details-repo-worktrees-heading"
      title={gt("Repository worktrees · {count}", { count: repoWorktrees.length })}
    >
      <ul className="flex flex-col">
        {repoWorktrees.map((entry) => (
          <li key={entry.worktreePath} className="flex h-8 items-center">
            <Menu>
              <MenuTrigger
                render={
                  <ThreadDetailsControl
                    size="sm"
                    variant="ghost"
                    aria-label={gt("{repository} on {branch} at {path}", {
                      repository: entry.repository,
                      branch: entry.branch,
                      path: entry.worktreePath,
                    })}
                  />
                }
              >
                <FolderGit2Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                <span className="min-w-0 truncate">{entry.repository}</span>
                <span className="min-w-0 truncate text-muted-foreground">{entry.branch}</span>
              </MenuTrigger>
              <MenuPopup align="end" className="max-w-(--available-width) min-w-60">
                <MenuGroup>
                  <MenuGroupLabel>
                    {entry.origin === "reused"
                      ? gt("Reused worktree at {path}", { path: entry.worktreePath })
                      : gt("Worktree at {path}", { path: entry.worktreePath })}
                  </MenuGroupLabel>
                  {props.onShowChanges ? (
                    <MenuItem onClick={() => props.onShowChanges?.(entry.worktreePath)}>
                      <FileDiffIcon className="size-3.5" />
                      <T>Show changes</T>
                    </MenuItem>
                  ) : null}
                  <MenuItem onClick={() => copyPath(entry)}>
                    <CopyIcon className="size-3.5" />
                    <T>Copy path</T>
                  </MenuItem>
                  <MenuItem
                    onClick={() =>
                      void detach({
                        environmentId: props.environmentId,
                        input: { threadId: props.threadId, worktreePath: entry.worktreePath },
                      })
                    }
                  >
                    <UnlinkIcon className="size-3.5" />
                    <T>Detach from thread</T>
                  </MenuItem>
                </MenuGroup>
              </MenuPopup>
            </Menu>
          </li>
        ))}
      </ul>
      <p className="px-1.5 pt-1 text-2xs text-muted-foreground">
        <T>
          Turn diffs and rollback include these. Rollback restores no files while another thread
          also works in one.
        </T>
      </p>
    </ThreadDetailsSection>
  );
}
