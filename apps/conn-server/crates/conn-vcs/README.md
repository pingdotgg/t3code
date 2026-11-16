# conn-vcs

Git for the Conn Server, through the `git` CLI as the T3 server does. The references are the
T3 server's `apps/server/src/vcs/*` (`GitVcsDriverCore.ts`), `ReviewService.ts`,
`WorktreeSetupTracker.ts` and `SourceControlDiscovery.ts`. `conn-server` serves it in
`src/methods/vcs.rs`; the thread launch reaches it through `src/host.rs`. `src/lib.rs` says
why the CLI and not `gix` or `git2`, with numbers.

| Module                    | Holds                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `process.rs`              | Every `git` child: a timeout, bounded stdout and stderr, killed on drop              |
| `commit.rs`              | Commit preview in a scratch index and all-file or selected-file commits |
| `repo.rs`                 | Shared lookups: top level, current branch, remotes, default branch, base, merge base |
| `status.rs`               | `vcs.refreshStatus` local and remote parts, the branch status                        |
| `hub.rs`                  | `subscribeVcsStatus`, `subscribeVcsBranch`: one entry per watched repository          |
| `refs.rs`                 | `vcs.listRefs`, `createRef`, `switchRef`, `init`, `pull`                             |
| `worktree.rs`             | `vcs.createWorktree`, `removeWorktree`, managed worktree paths                       |
| `review.rs`               | `review.getDiffPreview`, `getDiffFileContents`, `getBranchCommits`                   |
| `checkpoint.rs`           | Turn checkpoints: capture, restore, diff, authored paths, refs (`GitVcsDriver.ts` `checkpoints`) |
| `setup.rs`                | Worktree setup progress (`subscribeWorktreeSetup`) and `provision` for thread launch |
| `discovery.rs`            | The `git` and `jj` half of `server.discoverSourceControl` (hosts: `conn-source-control`) |

## Costs

- No state between calls except the hub and the setup tracker. The hub keeps one entry per
  repository a client watches and checks `HEAD` and the index by stat every 2 s; it runs
  `git` only when they change, after a `vcs.*` change, at turn end, and on
  `vcs.refreshStatus`. Remote status refreshes every 30 s while watched, with backoff.
- One local status refresh runs 14 `git` calls on a clean feature branch, 18 with an
  untracked file (the untracked totals use a temporary index). The remotes are read once per
  refresh (`repo::Remotes`).
- Setup entries are in memory: a finished setup stays 30 s; a running one stays until it ends
  or is cancelled.

## Checkpoints

A checkpoint is a commit of the whole working tree under
`refs/t3/orchestration-v2/checkpoints/<base64url(sha256(scope id)[:32 hex])>/ordinal/<n>` in the
workspace's repository, built in a scratch index (`<common dir>/t3-checkpoint-index-<uuid>`)
with `HEAD` as first parent, author "T3 Code", message `t3 checkpoint ref=<ref>`, and git's
`fsync` settings as T3 sets them. The user's index and working tree are not touched. Git
dedupes the objects: an unchanged tree costs one commit object. `src/checkpoint.rs` lists what
is not ported (branch-switch second parent, hand-flagged index entries, sparse checkouts,
ignored workspace folders, the embedded-repository retry).

## Safety

- Paths and refs from a caller go after `--end-of-options` or `--`, or are checked first
  (`is_object_id`, option-like names refused).
- `review.getDiffFileContents` reads a working file only inside the repository, after
  resolving links, and never one of the server's internal files (the caller passes the check).
- A worktree setup script runs in its own process group. The group is killed when the script
  exits, when the setup is cancelled and when the launch is dropped.

## Not done

- **Setup scripts on thread launch.** `provision` can run a script, but `conn-server`'s host
  passes none: a project's `runOnWorktreeCreate` script is skipped. The T3 server types the
  script into a thread terminal (`setup-<script id>`) and watches for a completion marker
  (`ProjectSetupScriptRunner.ts`). Doing the same needs the terminal manager and the project's
  scripts at launch.
- `pullRequests.*` and `sourceControl.*` live in `conn-source-control`.

## Check

`cargo test -p conn-vcs` runs every operation on scratch repositories (`tests/repos.rs`),
including a setup script that leaves background jobs, a cancel and a dropped launch.
