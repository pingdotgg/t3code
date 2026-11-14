import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId, ThreadRepoWorktree } from "@t3tools/contracts";
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
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const repoWorktrees = useAtomValue(environmentThreadDetails.repoWorktreesAtom(ref));
  const detach = useAtomCommand(threadEnvironment.detachRepoWorktree, { reportFailure: true });
  if (repoWorktrees.length === 0) return null;

  const copyPath = (entry: ThreadRepoWorktree) =>
    void writeTextToClipboard(entry.worktreePath, "worktree path").then((copied) => {
      if (copied) {
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: entry.worktreePath,
        });
      }
    });

  return (
    <ThreadDetailsSection
      headingId="thread-details-repo-worktrees-heading"
      title={`Repository worktrees · ${repoWorktrees.length}`}
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
                    aria-label={`${entry.repository} on ${entry.branch} at ${entry.worktreePath}`}
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
                    {entry.origin === "reused" ? "Reused worktree" : "Worktree"} at{" "}
                    {entry.worktreePath}
                  </MenuGroupLabel>
                  {props.onShowChanges ? (
                    <MenuItem onClick={() => props.onShowChanges?.(entry.worktreePath)}>
                      <FileDiffIcon className="size-3.5" />
                      Show changes
                    </MenuItem>
                  ) : null}
                  <MenuItem onClick={() => copyPath(entry)}>
                    <CopyIcon className="size-3.5" />
                    Copy path
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
                    Detach from thread
                  </MenuItem>
                </MenuGroup>
              </MenuPopup>
            </Menu>
          </li>
        ))}
      </ul>
      <p className="px-1.5 pt-1 text-2xs text-muted-foreground">
        Turn diffs and rollback include these. Rollback restores no files while another thread also
        works in one.
      </p>
    </ThreadDetailsSection>
  );
}
