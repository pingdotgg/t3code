# Jujutsu support

T3 Code supports Jujutsu `0.42.0` or newer for Git-backed repositories using colocated `.jj` and
`.git` metadata.

## Setup

Install `jj`, confirm `jj --version`, then initialize from T3 Code's source-control controls or run:

```sh
jj git init --colocate .
```

For an existing Git repository, run that command from its clean repository root. Colocation keeps
the existing Git object store and remotes while adding Jujutsu workspace metadata.

Automatic detection chooses jj when both `.jj` and `.git` exist. To make selection explicit, add
`.t3code/vcs.json`:

```json
{
  "vcs": {
    "kind": "jj"
  }
}
```

Use `"git"` instead to force Git for that project.

## Product concepts

- Workspace change: mutable working-copy commit `@` edited by one local or isolated workspace.
- Publish bookmark: explicit named ref moved to a finalized revision and pushed.
- Thread workspace: `jj workspace` used where Git uses a worktree.
- Finalize change: describes the selected work and creates a new empty working-copy change.

T3 Code never treats a bookmark pointing at `@` as an automatically selected publish bookmark.
Publishing always names one bookmark and one remote.

## Supported workflows

- detect, initialize, and clone colocated repositories;
- status, bookmarks, conflicts, divergence, and Git-format diffs;
- local and isolated thread workspaces;
- finalize all or selected files while preserving excluded edits;
- fetch updates without rewriting a non-empty workspace automatically;
- push one explicit bookmark and create or view a hosted change request;
- check out same-repository or fork change requests into a new empty change;
- capture, preview, restore, retain, and delete thread-local checkpoints.

## Colocation and Git tools

Git-aware agents and provider CLIs can still see `.git`. Avoid running concurrent history-changing
Git and jj commands in the same workspace. After an external tool changes Git refs, run `jj status`
or use T3 Code's refresh action before continuing.

T3 Code checkpoint refs live under `refs/t3code/`. They are local retention anchors, not branches or
bookmarks, and T3 Code never pushes them.

## Recovery

Inspect state first:

```sh
jj status
jj bookmark list --all-remotes
jj workspace list
jj operation log --limit 5
```

For a stale workspace, from that workspace run:

```sh
jj workspace update-stale
```

For remote divergence or conflicts, resolve the affected revision or bookmark explicitly. T3 Code
does not force-push, auto-rebase dirty work, or auto-resolve conflicts. Authentication failures use
the same Git remote credentials required by `jj git fetch` and `jj git push`.

Do not use `jj op restore` to recover one T3 Code thread. It restores repository-wide operation
state and can affect sibling workspaces. Use the thread checkpoint restore action, which restores
only selected workspace content and description.

## Intentional limitations

- Pure jj and non-colocated Git-backed repositories are not supported yet.
- T3 Code does not provide a general operation-log, revset, split, squash, absorb, or history-edit UI.
- Git index and commit-hook behavior is not emulated for selected-file finalization.
- Bookmark names published to Git must also be valid Git ref names.
- Automatic conflict resolution and automatic force push are never attempted.

Workflow telemetry records duration, cancellation/failure outcome, VCS kind, workflow, and operation.
It excludes repository paths, messages, patches, remote URLs, and credentials.
