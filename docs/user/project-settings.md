# Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Run worktree setup and teardown actions

Project actions can run automatically when T3 Code creates or removes a worktree. Use a setup
action to install dependencies or copy local environment files. Use a teardown action to stop
worktree-specific services or remove generated resources.

In **Settings** > **Projects**, edit an action and turn on **Run automatically on worktree
creation** or **Run automatically before worktree removal**. T3 Code runs teardown before it
deletes the worktree. If teardown fails, the worktree stays in place so you can fix the command
and try again.

Actions imported from `t3.json` support `runOnWorktreeCreate` and `runOnWorktreeRemove`.

## Keep the default branch current

Turn on **Automatically pull** in a project's settings to keep its default-branch checkout current.
T3 Code checks in the background and when the server starts. It uses the branch's configured
upstream and only performs a fast-forward pull when the checkout has no working-tree changes,
untracked files, or local commits.

The pull is skipped if the checkout is on another branch, has no upstream, or contains local work.
Pull failures do not prevent the server from starting.
