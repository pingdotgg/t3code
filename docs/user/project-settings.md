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

## Copy a project to another machine

In the web or desktop app, select a project in **Settings → Projects**. The copy action is available
when another connected machine has no checkout of that project and both servers support project copying.
Choose a source checkout, a destination machine, and a new folder. Browse the destination machine to
choose an existing parent folder, or enter the new folder path directly.

**Fresh checkout** clones the repository's default branch from its origin remote using the destination's
Git credentials. **One-time copy** transfers the current files, Git history, staged and unstaged work.
It supports folders without Git too. Ignored files, including `.env` and installed dependencies, are
included unless you turn that option off. Dependencies may need reinstalling on a different OS.
Pause edits while the snapshot is prepared; copies are limited to 10 GB and links must stay inside the project.

Both options copy the project name, icon, model and workspace defaults, automatic-pull preference,
browser-access preference, and actions. Provider credentials and conversations remain on their original
machine. Configure any missing provider instances on the destination. The source remains intact,
existing destination folders are never overwritten, and subsequent changes do not sync automatically.
