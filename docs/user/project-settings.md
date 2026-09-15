# Settings and project overrides

The Settings breadcrumb ends with the environment and project a change applies to. They start
at **All environments** and **All projects** and stay selected as you move between categories or
search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a project to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a project override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a project are shown read-only
while a project is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a project's own override. When projects override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a project to jump to it, or **Reset all** to make those projects follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Every other setting fans out to the selection.

## Defaults and inheritance

General contains the model and workspace for new threads. Integrations controls agent browser
access. Source Control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or project overrides depending on the
project crumb.

The Project category, shown while a project is selected, holds the project's name, icon, actions,
checkouts and removal. Actions belong to a project: editing them creates the project's own list
on each selected environment, and reset returns to the environment's shared list. A project's
`t3.json` actions can be imported there.

For workspace mode, a project's `t3.json` preference applies when the project has no override.
Browser access changes apply when an agent session next starts.

## Let agents use the host computer

**Cua computer use** lets agents control the machine running your T3 Code server
through Cua Driver. It is off by default, applies to the whole environment with no
project override, and is separate from **Agent browser access**. Every provider
receives it, unless you already configured a `cua-driver` MCP server of your own
for that provider.

Turn it on in **Settings > Integrations** with the host machine selected. On the
desktop app that owns the machine, T3 Code walks you through granting Accessibility
and Screen Recording before the switch turns on. The **Permissions** button next to
the switch reopens that check later. From another computer or phone, the switch turns
on immediately, but you still have to grant those permissions to T3 Code on the host.

Packaged T3 Code desktop includes Cua Driver. For a standalone server, set
`T3CODE_CUA_DRIVER_PATH` to the absolute path of your Cua Driver executable before
starting the server. Agent sessions started after enabling get the computer use tools.
Turning the switch off revokes T3 Code's managed access without touching MCP servers
you configured yourself.

To point an agent at a specific app, type `@` in the composer followed by the app's name
and pick it from the list. The chip tells the agent which app to drive and how to find
it with the computer use tools. Apps appear in that list only while Cua computer use is
on for the selected environment.

Agents act on windows in the background without raising them, so you can keep working
while they do. To watch, open the thread on the web or desktop: a floating card shows the
window the agent is driving and refreshes while the turn runs, then keeps the agent's last
screenshot. Close the card to stop the live capture; it comes back on the next screenshot.
The card follows the **Auto-show floating preview** setting under **Settings > Integrations**.

## Project icons

Select the project and open Project to choose an icon, emoji, or image. The choice applies to
every checkout in the project group and appears on connected clients. Choose **Automatic** to let
T3 Code detect an icon again.

When no image is found, web and desktop show a two-character monogram with colors
derived from the saved project name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

In Source Control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
