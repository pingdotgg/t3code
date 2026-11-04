---
title: "Settings and project overrides"
description: "Choose which T3 Code environments and projects a setting affects, inspect inheritance, resolve Mixed values, and manage workspace defaults."
updated: 2026-11-04
sources:
  - label: "Settings and project overrides"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md"
  - label: "File-backed defaults and built-in values"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/t3ProjectFile.ts"
faq:
  - question: "How do I change settings for one T3 Code project?"
    answer: "Select the project in the Applying settings for sentence at the top of a T3 Code server-setting page. Choose the environments to edit, then set an override or reset it to inherit."
  - question: "What does Mixed mean in T3 Code Settings?"
    answer: "T3 Code shows Mixed when selected environments have different values. Choosing a value applies it to the selection; selecting one environment lets you inspect that machine alone."
  - question: "Does All environments update offline T3 Code servers?"
    answer: "No. T3 Code bulk-edits connected environments, while offline environments keep their current values. All environments is not a synchronized global default."
  - question: "Why is my t3.json default not taking effect?"
    answer: "T3 Code resolves file-backed settings from a project override, then the environment setting, then t3.json, then the built-in default. Reset higher layers to Inherit when the repository file should decide."
  - question: "Can I disable an agent provider for one project?"
    answer: "Yes. With a project selected in T3 Code Settings → Providers, the provider switch applies to that project. It blocks new turns there, while an already-running turn finishes."
---

T3 Code lets you edit server defaults for selected environments and override them for a project. On web and desktop, use the “Applying settings for …” sentence at the top of a settings page to choose the scope. Device preferences, including appearance, ignore that server selection.

## Select the destination before changing a value

Server-setting pages begin with **All projects** and **All environments** selected. That selection remains as you change categories or search for settings. Check it before editing a different kind of preference.

1. Open the relevant Settings category.
2. Choose one environment to inspect one machine, or keep **All environments** for a bulk edit.
3. Keep **All projects** to edit environment defaults, or select a project for its overrides.
4. Inspect the layers icon beside the server setting's title.
5. Change the value or reset an override to inherit.

A setting that cannot be overridden by a project becomes read-only while a project is selected. Choose **All projects** to edit that environment-wide value. Providers and diagnostics show one machine at a time, initially the primary environment.

| Intended result                        | Selection or location                                        |
| -------------------------------------- | ------------------------------------------------------------ |
| Change a server default                | All projects, then the intended environments                 |
| Make one repository behave differently | Select the project and destination environments              |
| Change local appearance                | Settings → Appearance, independent of server selection       |
| Share repository defaults through Git  | The repository's [t3.json](/learn/customize/t3-project-file) |
| Inspect one machine's current value    | Select that environment alone                                |

## Resolve Mixed values and inspect inheritance

**Mixed** means the selected environments disagree. The layers icon turns amber. Selecting a value writes it to every selected environment, so narrow the selection first when you want to preserve differences.

The layers icon shows where each value comes from. Use it to inspect the chain on every selected environment. Changing an environment default leaves existing project overrides intact. If projects override that setting, the chain lists them and counts them beside the icon.

Select a listed project to inspect its override. Use **Reset all** only when you intend those projects to follow the environment again. This gives you a path for changing a default without silently replacing deliberate project choices.

An all-environments edit reaches connected machines. Offline machines retain their current values. Revisit them after connecting if they also need the change.

## Let repository defaults supply workspace behavior

For settings also declared in `t3.json`, precedence runs from highest to lowest:

1. Project override.
2. Environment setting.
3. Repository `t3.json`.
4. Built-in default.

**Inherit** means the next layer decides. A repository file cannot replace an explicit project or environment choice. The two file-backed defaults are `defaultThreadEnvMode` and `worktreeSubmodules`. Their built-in values are `local` and `recursive`.

The Threads category controls model and workspace defaults for new threads. Source control contains automatic pull, merge-method defaults, and text generation. Browser controls agent browser access; changes apply when an agent session next starts.

When deciding which agent actions are allowed, read [permission modes](/learn/safety/permission-modes) and [managed policy](/learn/safety/managed-policy). Use the settings scope controls to target a change, then consult the relevant feature's policy behavior.

## Enable or disable a provider for one project

Select a project in `Settings → Providers` to make that provider's switch project-specific. You can enable a provider for one project even when the machine disables it, or disable it for a project while leaving it available elsewhere.

The project's model pickers follow that switch. New turns cannot start through a disabled provider, including queued messages and follow-ups from delegated tasks. A turn already running finishes. A delegated result still reaches its parent thread for the next turn.

Reset the switch to inherit the machine's choice. Other provider settings remain per machine. Disabling a provider is also different from changing what [Usage](/learn/customize/usage-and-limits) can read from existing account history.

## Configure worktrees for the repository

In `Settings → Worktrees → Worktree branch naming`, choose a static prefix, a model-selected semantic prefix, or custom naming instructions. The static prefix defaults to `t3/`. It may be empty, and a trailing slash is optional.

These choices affect automatically named new branches. They leave worktree directory names intact. If naming fails, or a generated name is invalid or taken, the temporary branch name remains.

Under Worktrees' Advanced settings, **Submodules** offers recursive initialization, **Top level only**, or **Skip**. Use top-level initialization when nested submodules make setup slow. Choose Skip when a setup script should populate them. Repository defaults follow the same inheritance chain.

`Settings → Worktrees → Worktree location` sets a per-machine destination. Existing worktrees stay at their current locations. Use [source control and pull requests](/learn/workspace/source-control) for the review workflow after those workspaces exist.

## Import project actions and choose an icon

Under Code, the Projects category holds project identity, actions, checkouts, and removal. You can import actions declared in `t3.json` there. Editing actions creates the project's own list on each selected environment; resetting restores the environment's shared list.

Choose an icon, emoji, monogram, or image for the project. The choice applies to its grouped checkouts and appears on connected clients. **Automatic** resumes icon detection. This is separate from [appearance themes](/learn/customize/appearance), which remain device preferences.

Pin a project to place it first in project pickers. Archive a finished project to remove it from those pickers while keeping its threads, settings, and files. Unarchive it from Settings when needed. Projects spanning several machines require every machine connected to pin or archive them.

## Apply the same scope rules on mobile

Mobile Settings has a header filter for environments and projects. **All projects** edits server defaults; selecting a project edits its overrides. **Use defaults** removes the selected page's project overrides.

Environment-wide rows stay read-only with a project selected. Phone-only settings, including appearance and keyboard preferences, ignore the filter. Use `Settings → Projects` to rename a project across its selected connected checkouts and inspect their locations.

## Next steps

[Write repository defaults in t3.json](/learn/customize/t3-project-file) after checking the higher-priority layers.
Review [managed team policy](/learn/safety/managed-policy) for organization controls and [usage and limits](/learn/customize/usage-and-limits) for account readings.
Return to [settings and customization](/learn/customize) to distinguish project settings from device preferences.
