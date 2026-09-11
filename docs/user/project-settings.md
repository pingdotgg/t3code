# Settings and project overrides

Settings has two selectors in the header: an environment and a project. They start at
**All environments** and **All projects** and stay selected as you move between categories or
search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.
Providers, keybindings and diagnostics need a single environment.

Choose a project to override settings for it. Where a repository is registered more than once on
the selected environments, the project can be narrowed to one checkout. Each row shows whether the
value is inherited from the environment or overridden for the project, and an override can be
reset to inherit again. Settings that cannot be overridden by a project are shown read-only while
a project is selected. Mixed values mean the selected environments or checkouts disagree.

## Defaults and inheritance

General contains the model and workspace for new threads. Integrations controls agent browser
access, Source Control contains automatic pull and text generation, and Actions manages commands.
The same rows edit environment defaults or project overrides depending on the project selector.
The Overview category, shown while a project is selected, holds the project's name, icon,
checkouts and default merge method.

Changing an environment default preserves explicit project overrides. For workspace mode, a
project's `t3.json` preference applies when the project has no override. Browser access changes
apply when an agent session next starts.

Environment actions are available to inheriting checkouts. Editing a project's actions creates an
independent list; reset that list to inherit again. Select a single checkout to import actions
from its `t3.json`. Project grouping has a device-wide default with individual checkout overrides.

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
