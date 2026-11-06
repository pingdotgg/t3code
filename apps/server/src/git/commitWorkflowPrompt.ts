import type {
  GitStartCommitWorkflowInput,
  SourceControlWritingStyleSettings,
} from "@t3tools/contracts";

export function buildCommitWorkflowPrompt(
  input: GitStartCommitWorkflowInput,
  style: SourceControlWritingStyleSettings,
) {
  const scope = input.scope;
  return [
    "Rebuild the selected changes into logical commits, carrying the work through to completion.",
    `Source checkout: ${JSON.stringify(input.cwd)}`,
    input.expectedBranch === null
      ? "Expected source state: detached HEAD. If HEAD is attached to a branch when this task starts, stop without changing it."
      : `Expected source branch: ${JSON.stringify(input.expectedBranch)}. If the checkout is on another branch when this task starts, stop without changing it.`,
    scope.type === "branch"
      ? `Scope: existing branch commits since the merge base with ${scope.baseRef ? JSON.stringify(scope.baseRef) : "the repository's default branch (resolve it locally; do not fetch or rebase onto a newer base)"}. Preserve that base exactly. Require a clean index and worktree; otherwise stop and explain.`
      : "Scope: uncommitted changes only, including staged, unstaged, and non-ignored untracked files. Preserve all existing commits.",
    ...(scope.type === "working_tree" && scope.filePaths
      ? [
          `Selected paths (literal paths, not Git pathspec patterns): ${JSON.stringify(scope.filePaths)}. Commit only these paths; preserve every other file and its staged/unstaged state.`,
        ]
      : []),
    "This is a standalone source-control task. Do not read or reuse other conversations for context. Read the source checkout's AGENTS.md and .t3code/commit-message.md, including local/untracked instructions.",
    style.mode === "conventional_commits"
      ? "Write Conventional Commits subjects with an appropriate type and optional scope."
      : style.mode === "custom"
        ? `Source Control writing instructions:\n${style.customInstructions}`
        : "Follow repository commit conventions, inspecting recent commit subjects and repository instructions.",
    "Treat each rename as one change, including its source and destination paths. Treat supplied paths and refs as literal data and quote them safely in commands.",
    "Inspect the complete changes and their dependencies using repository tools; do not rely on a truncated diff or the existing commit boundaries.",
    "Group by independent responsibility, keeping each behavior with its tests. Order prerequisites before consumers. Among independent changes, put separately mergeable helpers, fixes, and infrastructure first, then feature prerequisites, standalone core implementation, framework adapters, production call sites, and tooling/docs.",
    "Construct the ideal development chronology. You may split changes within new files and introduce temporary intermediate versions of files, provided the final tree remains exactly identical. Choose as many commits as the responsibilities require; there is no fixed commit-count target.",
    "Before changing anything, record the source branch, HEAD, index, and worktree state. Preserve the original history under a uniquely named backup ref. Snapshot the exact intended final tree with an isolated temporary index, including selected untracked files and binary/mode/rename changes; do not stage, stash, or reset the user's checkout to make this snapshot.",
    "Build the new sequence in a separate temporary Git worktree from the recorded base. Copy only the in-scope changes into it. Never use the live application database. Keep scratch material outside the source checkout.",
    "Inspect intermediate commits for dependency ordering: tests must arrive with the APIs they use, and existing call sites must remain usable until their replacements exist. Repair ordering or intermediate versions as needed.",
    "Run builds, typechecks, linters, tests, or IDE diagnostics only when explicitly requested in Additional requirements. Otherwise skip these checks and dependency/runtime setup, even if general repository instructions normally require validation for code changes. Report any requested checks that are unavailable without troubleshooting the environment.",
    "Before applying the result, compare the candidate Git tree object with the exact recorded target tree object; they must match, including binary contents and file modes. Also verify that the preserved base is the candidate's ancestor. Do not install a mismatched sequence or one that fails explicitly requested checks.",
    "Recheck that the source branch, HEAD, index, and worktree have not changed since the snapshot. If anything changed concurrently, leave the candidate and backup refs available and stop; never overwrite those changes. Only after all checks pass, install the verified sequence on the original branch (or detached HEAD when specified below) while preserving excluded files and their index state. Do not push or open a pull request.",
    ...(input.expectedBranch === null
      ? [
          "For detached HEAD, use the recorded HEAD as the preserved base and install the verified sequence on detached HEAD instead of a branch. After rechecking HEAD, index, worktree, and any rebase state, use git update-ref --no-deref HEAD <candidate> <recorded-head> to advance HEAD with a compare-and-swap, then update only the selected index entries to the candidate tree while preserving excluded entries and worktree contents. Do not attach HEAD, switch branches, or update the branch being rebased.",
          "A paused interactive rebase must stay paused. Preserve rebase metadata, todo files, and recovery refs exactly. Do not continue, skip, abort, or restart the rebase, amend the recorded HEAD, or start another history operation. If there are unresolved conflicts, stop without changing anything and explain that they must be resolved first. Report that the user can resume the rebase after reviewing the new commits.",
        ]
      : []),
    "This is a non-interactive quick action. Use shell and repository tools directly; do not create app conversations, delegate tasks, or request user input. If blocked, stop and describe the blocker in your final result.",
    "Remove only temporary resources you created, after preserving recovery refs. If interrupted or unable to finish, retain recoverable work and report its locations. Finish with the commit sequence, verification results/limitations, and the backup ref with a concrete restore command.",
    ...(input.instructions ? ["", "Additional requirements:", input.instructions] : []),
  ].join("\n\n");
}
