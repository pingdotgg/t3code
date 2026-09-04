# Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files. If it does not find an image, it chooses a built-in
icon from the saved project name. In web and desktop, this icon stays the same when the sidebar
shows a repository label such as `owner/repo`.

To choose a different icon or emoji:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Next to **Project icon**, select **Choose icon**.
4. Search the full Lucide icon set and choose a color, or switch to **Emoji** and choose or paste
   an emoji.

To use an image from the project instead, select **Choose file**, search for an image, and select
it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Keep the default branch current

Turn on **Automatically pull** in a project's settings to keep its default-branch checkout current.
T3 Code checks in the background and when the server starts. It uses the branch's configured
upstream and only performs a fast-forward pull when the checkout has no working-tree changes,
untracked files, or local commits.

The pull is skipped if the checkout is on another branch, has no upstream, or contains local work.
Pull failures do not prevent the server from starting.

## Choose where worktrees are created

By default, T3 Code creates each worktree thread in its own data directory, at
`<T3 home>/worktrees/<repository>/<branch>`. Tooling that resolves configuration by walking up
from the working directory — direnv, nix, mise, devcontainers, and most monorepo tooling — does
not find that location, and some machines need worktrees on a particular drive.

To place them somewhere else, set **Worktree location** in a project's settings to an absolute
path. New worktrees for that project are then created at `<location>/<branch>`. Pointing it at
`~/code/myrepo.worktrees`, for example, gives the sibling layout other Git clients use.

The path must be absolute; `~/` is expanded on the machine that runs the server. The setting
applies to every checkout in the project group and to every way a worktree thread starts,
including pull requests opened as threads and threads started from mobile.

Leave the field empty to go back to the default location. Changing it never moves worktrees that
already exist — they stay where they were created, and their diffs keep working.
