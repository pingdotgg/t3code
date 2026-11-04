---
title: "The t3.json project file"
description: "Configure T3 Code projects with t3.json: every supported field, shared scripts, worktree defaults, a real example, and JSON Schema validation."
updated: 2026-11-04
sources:
  - label: "Project file schema and field descriptions"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/t3ProjectFile.ts"
  - label: "Project script icon values"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/project.ts"
  - label: "Shared parser and JSON Schema generation"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/t3ProjectFile.ts"
  - label: "Project file parser tests"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/t3ProjectFile.test.ts"
  - label: "Published schema route"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/pages/schema/t3.json.ts"
  - label: "T3 Code repository's own t3.json"
    url: "https://github.com/pingdotgg/t3code/blob/main/t3.json"
  - label: "Project action import behavior"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/settings/ProjectActionsSettings.tsx"
  - label: "Settings and project overrides"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md"
faq:
  - question: "What is t3.json?"
    answer: "T3 Code reads t3.json at the repository root as checked-in project configuration. It supports an icon path, new-thread workspace and submodule defaults, and shared script definitions."
  - question: "Where does the T3 Code project config file go?"
    answer: "Put t3.json at the repository root. T3 Code reads the file from the project's checkout, rather than treating it as a machine-wide settings file."
  - question: "What is the t3.json schema URL?"
    answer: "Use https://t3.codes/schema/t3.json as the $schema value in T3 Code project configuration. Schema-aware editors can use it to validate supported fields and values."
  - question: "Can t3.json override T3 Code Settings?"
    answer: "For file-backed defaults, T3 Code checks the project override, then the environment setting, then t3.json, then the built-in default. Set higher layers to Inherit if you want the file to decide."
  - question: "Does t3.json support comments?"
    answer: "T3 Code's project-file parser accepts JSONC comments and trailing commas. A standard JSON example also works and can be validated with the published schema."
---

T3 Code reads `t3.json` at the repository root for shared project configuration. The file defines an icon path, defaults for new-thread workspaces and worktree submodules, and scripts that project members can import. Add `"$schema": "https://t3.codes/schema/t3.json"` for validation in a schema-aware editor.

## Add t3.json at the repository root

Use this file for repository-owned configuration that should travel with the code. Keep personal theme choices in [Appearance](/learn/customize/appearance), and use [project settings](/learn/customize/project-settings) for local overrides.

1. Create `t3.json` at the repository root.
2. Add the `$schema` line.
3. Add only the fields your repository needs.
4. Inspect editor validation before sharing the file through Git.
5. Check Settings inheritance if a file-backed default does not appear to apply.

Every top-level field is optional. A script entry must have a name and a command. The shared parser accepts JSONC comments and trailing commas, but standard JSON is sufficient for the examples below.

The schema is published at [the official t3.json schema](https://t3.codes/schema/t3.json). T3 Code generates it from the same contract used by the shared parser. The generated schema marks excess properties as errors, which helps an editor catch misspelled or unsupported fields.

## Understand every top-level field

| Field                  | What you put there                                             | When to use it                                                           |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `$schema`              | The schema URL, normally `https://t3.codes/schema/t3.json`     | Enable schema-aware editor validation.                                   |
| `iconPath`             | A nonempty workspace-relative image path, up to 512 characters | Choose a project icon before T3 Code checks its built-in icon locations. |
| `defaultThreadEnvMode` | `"worktree"` or `"local"`                                      | Start new threads in fresh Git worktrees or the current checkout.        |
| `worktreeSubmodules`   | `"recursive"`, `"top-level"`, or `"none"`                      | Decide which submodules new worktrees initialize.                        |
| `scripts`              | An array of up to 50 script definitions                        | Share project commands that members can import into T3 Code.             |

`defaultThreadEnvMode` controls where new threads begin. Use `worktree` when a new thread should have a fresh Git worktree. Use `local` when it should start in the current checkout. With no higher setting or file value, the built-in default is `local`.

`worktreeSubmodules` controls population of Git submodules. `recursive` initializes nested submodules and is the built-in default. `top-level` initializes only the submodules declared by the repository itself. `none` leaves every submodule empty for a setup script to handle.

Use the smallest set of fields that expresses the repository's requirements. Omitting a field allows the relevant settings layers or built-in behavior to decide.

## Configure project scripts

A script is a shell command with display information and optional lifecycle behavior. The file's shape differs from a keyboard rule: it defines the action, while [keybindings](/learn/customize/keybindings) define keys that can run an imported project action.

| Script field          | Required? | Meaning                                                                                                                            |
| --------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `name`                | Yes       | Nonempty display name in the scripts menu.                                                                                         |
| `command`             | Yes       | Nonempty shell command executed in a T3 Code terminal at the project root.                                                         |
| `icon`                | No        | Menu icon: `play`, `test`, `lint`, `configure`, `build`, or `debug`. It defaults to `play`.                                        |
| `runOnWorktreeCreate` | No        | When true, run automatically after a worktree is created for a new thread.                                                         |
| `runOnSettle`         | No        | When true, run in the thread's own worktree whenever it settles. Threads without their own worktree skip it.                       |
| `async`               | No        | For worktree-creation scripts only. True, the default, starts the agent while setup continues. False waits for the script to exit. |
| `previewUrl`          | No        | Nonempty URL opened in the in-app browser preview when the script runs. Desktop honors this field.                                 |
| `autoOpenPreview`     | No        | When true, open the preview panel at `previewUrl` as the script starts.                                                            |

Use `async: false` for setup that must finish before the agent begins. Leave asynchronous setup enabled when the agent can start while the command continues. The flag only controls `runOnWorktreeCreate` scripts.

The two lifecycle flags default to false when importing an action. `autoOpenPreview` also defaults to false and needs a `previewUrl`; the importer does not enable automatic opening without that URL. The optional preview fields are useful for a desktop development action that opens its preview as it starts.

`runOnSettle` can support cleanup commands such as removing build output. Its own-worktree requirement matters: a thread working in the shared checkout skips the settle script.

## Start from T3 Code's real repository example

The T3 Code repository contains this configuration:

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "iconPath": "assets/dev/blueprint-web-apple-touch-180.png",
  "scripts": [
    {
      "name": "Setup Worktree",
      "command": "node scripts/setup-worktree.ts",
      "icon": "configure",
      "runOnWorktreeCreate": true
    }
  ]
}
```

The icon path points into that repository. The action declares its setup command and marks it for new-worktree creation. Because it omits `async`, the declared setup behavior allows the agent to start while setup runs.

Use your own repository's image and command paths when adapting the example. The two defaults for workspace and submodules are absent here, so those fields do not supply repository-specific values. See [build T3 Code from source](/learn/open-source/build-from-source) for the contributor workflow associated with this repository.

## Import actions and diagnose a missing entry

Select the project in Settings and open its Projects category under Code. The Actions section offers **Import scripts**, with an **Import from t3.json** menu for available definitions.

The importer omits entries whose command already exists or whose name matches an existing action without regard to case. If one action is absent from the import list, check for an existing match before changing the file.

If the checkout's file fails to parse, the Actions section shows **t3.json is invalid**. Check syntax and icon values. An invalid file's actions and icon declarations are ignored, so fix the whole file before debugging individual imports.

## Find why a repository default is masked

For workspace and submodule defaults, T3 Code checks a project override first, then the environment setting, then `t3.json`, and finally the built-in default. Leave the first two layers on **Inherit** when repository configuration should decide.

Submodule initialization reads the file from the branch being checked out. A file change on another branch may therefore differ from the configuration used for a new worktree. Inspect both the checked-out file and the Settings layers before treating the behavior as a parser failure.

## Next steps

[Inspect project inheritance](/learn/customize/project-settings) and [bind imported script actions](/learn/customize/keybindings).
Use [source control](/learn/workspace/source-control) to review repository configuration changes with the rest of your work.
Return to [settings and customization](/learn/customize) for preferences outside `t3.json`.
