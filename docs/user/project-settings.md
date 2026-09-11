# Project settings

Open **Settings → Projects**. The project and machine pickers start at **All projects** and
**All machines**.

Change the default model, workspace, automatic pull, agent browser access, or actions for projects that inherit those values.
Select an individual project to override a default. Reset its row to inherit again. Changing a
default preserves explicit project overrides. Workspace preferences in `t3.json` take precedence
over machine defaults when the project has no explicit workspace override.

Select a machine to limit edits to it. **All machines** writes defaults to connected machines;
offline machines keep their previous values. Mixed values are indicated when selected machines
or checkouts disagree. Browser access changes apply when an agent session next starts.

Project grouping has a client-wide default across machines, with individual checkout overrides.
Shared actions apply to inheriting projects; editing a project's actions creates an independent list.
Reset that list to use shared actions again. Existing project actions are preserved.

Project names, icons, removal, and importing actions from a checkout remain project-specific.
When there are several checkouts, the checkout picker selects which actions and grouping to edit.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to selected checkouts in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.

## Choose where worktrees are created

By default, T3 Code creates each worktree thread in its own data directory, at
`<T3 home>/worktrees/<repository>/<branch>`. Tooling that resolves configuration by walking up
from the working directory — direnv, nix, mise, devcontainers, and most monorepo tooling — does
not find that location, and some machines need worktrees on a particular drive.

To place them somewhere else, set **Worktree location** under **Checkout** in a project's
settings to an absolute path. New worktrees for that checkout are then created at
`<location>/<branch>`. Pointing it at `~/code/myrepo.worktrees`, for example, gives the sibling
layout other Git clients use.

The path must be absolute, and `~/` is expanded on the machine that runs the server. Because it
names a directory on that machine, it belongs to one checkout rather than the whole project
group: a project open on two machines gets a location per machine. Within a checkout it applies
to every way a worktree thread starts, including pull requests opened as threads and threads
started from mobile. A path the hosting server cannot read as absolute — a Windows path on a
Linux server, say — is ignored in favor of the default location.

Give each checkout its own location. Two checkouts pointed at the same directory produce the
same path for the same branch name, and the second worktree fails to be created rather than
overwriting the first.

Leave the field empty to go back to the default location. Changing it never moves worktrees that
already exist — they stay where they were created, and their diffs keep working.
