---
title: "Settings and customization"
description: "Customize T3 Code themes, keyboard shortcuts, project defaults, and t3.json, and understand the usage and limits reported by your agents."
updated: 2026-11-04
sources:
  - label: "Appearance and themes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/appearance.md"
  - label: "Keybindings"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md"
  - label: "Keyboard focus"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/keyboard-focus.md"
  - label: "Settings and project overrides"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md"
  - label: "T3 project file contract"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/t3ProjectFile.ts"
  - label: "Usage and limits"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
faq:
  - question: "Where do I customize T3 Code?"
    answer: "T3 Code has Appearance and Keybindings pages in Settings on web and desktop. Server settings also let you select the environments and project a change applies to."
  - question: "Do T3 Code settings sync to all my machines?"
    answer: "T3 Code stores appearance separately on each device or browser. Editing all connected environments changes their server settings together, but offline environments keep their existing values."
  - question: "Can I share T3 Code project settings in Git?"
    answer: "T3 Code reads t3.json at the repository root for shared project defaults, an icon path, and scripts. Project and environment overrides take precedence over the file's workspace and submodule defaults."
---

T3 Code lets you customize appearance, keyboard controls, and project behavior from Settings. Device preferences stay on the device, while server settings can apply to selected environments and projects. A repository's `t3.json` supplies shared defaults and scripts.

## Choose the right place for a change

Start with what you want to change and who needs that change. A theme for your laptop belongs in device preferences. A worktree default for one repository belongs in a project override or its checked-in configuration.

| Your task                                          | Start here                                                          | What to check                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| Change colors or light and dark mode               | [Appearance and themes](/learn/customize/appearance)                | Each device or browser keeps its preference.                   |
| Change a shortcut or composer send behavior        | [Keybindings](/learn/customize/keybindings)                         | Focus conditions can change which command runs.                |
| Move through threads and panels without a mouse    | [Keyboard focus](/learn/customize/keyboard-focus)                   | Hidden panels are skipped during area navigation.              |
| Set defaults for a machine or one project          | [Settings and project overrides](/learn/customize/project-settings) | Select the intended project and environments before editing.   |
| Share repository defaults and setup commands       | [The t3.json project file](/learn/customize/t3-project-file)        | Higher-priority overrides can mask file defaults.              |
| Inspect tokens, estimated cost, or remaining quota | [Usage and limits](/learn/customize/usage-and-limits)               | History totals and provider limits answer different questions. |

## Understand which machine a setting affects

On web and desktop, server-setting pages show an “Applying settings for …” sentence. Use it to choose a project and connected environments. **All environments** edits the connected selection together. It does not create a synchronized global setting for offline machines.

Appearance pages omit that sentence because their preferences belong to the device or browser. Mobile appearance also has its own themes and text, code, and terminal preferences. Selecting a server does not make your phone adopt its theme.

When server values disagree, Settings shows **Mixed**. Select one environment to inspect it, or choose a value to apply across the selection. Use the layers icon to inspect inheritance before replacing an unfamiliar value.

## Separate workspace defaults from agent permissions

A new-thread workspace can come from a project override, the environment, `t3.json`, or the built-in default, in that order. Leave higher layers on **Inherit** when the repository should supply the decision.

Permissions require a separate decision. Read [permission modes](/learn/safety/permission-modes) and [managed policy for teams](/learn/safety/managed-policy) when deciding what an agent may do. A theme or keyboard preference is a different kind of customization from permission policy.

## Next steps

[Choose an appearance](/learn/customize/appearance), then [set the shortcuts you use most](/learn/customize/keybindings).
[Inspect project inheritance](/learn/customize/project-settings) before adding shared defaults to [t3.json](/learn/customize/t3-project-file).
Use [the library](/learn) to continue with providers, threads, or workspace features.
