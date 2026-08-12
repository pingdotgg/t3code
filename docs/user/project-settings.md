# Project settings

## Work with multiple repositories

A project can include several Git repositories without moving them under one parent folder. The
first repository is the **primary repository**: new threads start there, and project-level Git
actions use it by default. Agents can read and edit every attached repository. File search,
mentions, diffs, checkpoints, and isolated worktrees span the complete repository list.

To create a multi-repository project, open the Command Palette, choose **Add Project** →
**Multiple repositories**, select the primary repository, attach at least one more repository, and
choose **Create project**.

To change an existing project, open **Project settings**, find **Checkout** → **Repositories**, and
choose **Manage repositories**. You can attach or remove paths and make another repository primary.
Paths belong to the environment where the project runs, so this also works with remote projects.
Existing isolated threads keep the worktrees they started with. Repository changes apply to new
threads, which avoids silently changing the filesystem available to work already in progress.

You can also import a VS Code `.code-workspace` file from the Add Project browser. T3 Code imports
its existing Git folders once; later changes are saved to the T3 Code project and do not rewrite the
workspace file.

## Customize a project icon

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
