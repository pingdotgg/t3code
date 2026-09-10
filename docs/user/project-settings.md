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

# Add product context

Open **Settings**, select **Projects**, choose a project, then find **Product context**. The default document is `PRODUCT.md`, but you can choose another repository-relative Markdown path.

Select **Start conversation** to open a project-linked agent thread. The agent inspects the repository before asking focused questions, maintains a living product-document draft, and distinguishes human-confirmed information from repository inferences and unknowns. It asks for approval before writing or replacing the document.

After reviewing the saved document, turn on **Confirmed for automation**. Scheduled product opportunity discovery will not use an unconfirmed document. Changing the document path clears confirmation so the new source must be reviewed explicitly.

# Control project automations

The **Automations** section lets you independently allow or pause repository reviews, continuous improvement, product opportunity discovery, decision follow-up, pull request rollups, and inactive worktree cleanup. These controls apply to every checkout grouped under the project. Global automation settings still determine whether an allowed automation is running and how it is scheduled.

## Automatically pull

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
