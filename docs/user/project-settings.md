# Settings and project overrides

In web and desktop Settings, choose a target at the top before editing. That target stays selected
as you move between categories or search for a setting. Settings that belong to another target
explain where to change them; opening a category does not change your selection.

Choose **This device** for preferences such as appearance, confirmations, and browser profiles.
These are saved in the current client. Choose an environment for defaults stored on that server,
shared by clients connected to it. Providers and keybindings require a single environment.

**All environments** applies edits to connected environments only. Offline environments keep their
current settings. This is a bulk edit, not a synchronized global default: connecting another
environment later does not apply previous edits to it.

To override defaults, select a project, then all its checkouts, one environment, or a specific
checkout. **All checkouts** updates the project's currently known checkouts, not a permanent default
for future copies of that repository. Offline checkouts cannot be updated. Mixed values mean the
selected environments or checkouts disagree.

## Defaults and inheritance

General contains the default model and workspace. Integrations controls agent browser access,
Source Control contains automatic pull, and Actions manages commands. The same categories contain
project overrides when a project is selected. Overview contains project identity and checkout
management.

Rows show whether a value is overridden or inherited. Reset an override to use its environment's
default again. Changing an environment default preserves explicit project overrides. For workspace
mode, a project's `t3.json` preference takes precedence over the environment default when there is
no explicit project override. Browser access changes apply when an agent session next starts.

Environment actions are available to inheriting checkouts. Editing a checkout's actions creates an
independent list; reset that list to inherit again. Select a checkout to import actions from its
`t3.json`. Project grouping has a device-wide default with individual checkout overrides.

## Project icons

Select the project and open Overview to choose an icon, emoji, or image. The choice applies
to selected checkouts in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Keep the default branch current

In Source Control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
