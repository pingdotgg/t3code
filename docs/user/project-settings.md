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

## Exclude directories from workspace search

Create a `.ignore` file in the workspace root to exclude generated files or large directories from the Files panel, filename search, and content search.
It uses Git ignore syntax and works in plain directories and Subversion or Mercurial working copies as well as Git repositories.
For example:

```gitignore
build/
.gradle/
platforms/
obj/
bin/
```

Choose patterns that match generated output in your project; an excluded directory will not appear in workspace search.
Remove a pattern to include that directory again.
If results still reflect the old rules, restart the T3 Code server for that environment to rebuild its workspace index.
For a remote environment, edit the `.ignore` file on the machine that hosts the workspace.

Existing `.gitignore` rules also apply when the workspace is inside a Git repository.
A `.gitignore` file alone has no effect in a non-Git workspace; use `.ignore` there.
Subversion's `.svn` and Mercurial's `.hg` metadata directories are already excluded without an ignore file.

These exclusions control T3 Code's workspace index, not which files an agent can access.
Excluding unnecessary directories reduces scanning work, but a sufficiently large workspace can still reach the index scan timeout.
