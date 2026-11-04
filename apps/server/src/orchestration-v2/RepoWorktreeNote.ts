import type { ServerSettings, ThreadRepoWorktree } from "@t3tools/contracts";

const MAX_LISTED_WORKTREES = 20;

const RULES = [
  "This thread stays in the project folder, which holds several Git repositories. Leave the source checkouts in the folder as they are: do not edit, commit, or switch branches there.",
  "- Before changing a repository, call `t3_repo_worktree_ensure` with its path relative to the folder, an exact branch, and a `baseRef` for a new branch. Do every edit, build, test, and commit for that repository in the returned `worktreePath`. Call it again whenever the work reaches another repository.",
  "- A worktree that already has the branch is reused as it is. Keep its uncommitted edits: never stash, reset, or clean them. Use a new branch name for new, independent work, and pass `useExistingBranch:true` only to continue an existing branch on purpose.",
  "- To change a submodule, ensure a worktree for the submodule's path too (for example `service/framework`) and commit there. Then call `t3_repo_worktree_set_submodule` to point the parent worktree's submodule at that commit and stage the gitlink, and commit the parent with ordinary git. Repeat after each new submodule commit.",
  "- `t3_worktree_status` lists the attached worktrees; `t3_repo_worktree_detach` forgets one without deleting anything.",
].join("\n");

const REMINDER =
  "Repository worktrees are on for this project folder: before changing a repository inside it, call `t3_repo_worktree_ensure` and work in the returned worktree.";

/**
 * Sent ahead of the user's message, as restart notes and context handoffs
 * are, so every provider gets it the same way. The rules go out on a provider
 * thread's first turn; later turns repeat only what compaction or a resumed
 * session may have lost: the project guidance and where the work is.
 *
 * Empty when the project has the feature off, when the session has no T3 MCP
 * server (the note would point at tools it cannot call), and for slash
 * commands, which must stay first in the prompt.
 */
export function repoWorktreeNote(input: {
  readonly userText: string;
  readonly hasT3Mcp: boolean;
  readonly settings: Pick<ServerSettings, "repoWorktrees" | "repoWorktreeInstructions"> | null;
  readonly firstTurn: boolean;
  readonly repoWorktrees: ReadonlyArray<ThreadRepoWorktree>;
}): string {
  if (
    !input.hasT3Mcp ||
    input.settings === null ||
    !input.settings.repoWorktrees ||
    input.userText.trimStart().startsWith("/")
  ) {
    return "";
  }
  const instructions = input.settings.repoWorktreeInstructions;
  const listed = input.repoWorktrees.slice(0, MAX_LISTED_WORKTREES);
  const omitted = input.repoWorktrees.length - listed.length;
  const sections = [
    input.firstTurn ? RULES : REMINDER,
    ...(instructions === "" ? [] : [`Project guidance:\n${instructions}`]),
    ...(listed.length === 0
      ? []
      : [
          [
            "Attached repository worktrees:",
            ...listed.map(
              (entry) => `- ${entry.repository} on ${entry.branch}: ${entry.worktreePath}`,
            ),
            ...(omitted > 0 ? [`- and ${omitted} more (see t3_worktree_status)`] : []),
          ].join("\n"),
        ]),
  ];
  return `<t3_repo_worktrees>\n${sections.join("\n\n")}\n</t3_repo_worktrees>`;
}
