---
name: t3code-project-control
description: Controls T3 Code projects through the t3 CLI: list, show, add, remove, rename, search, browse, write files, open in editor, and configure project defaults/scripts. Use when the user asks to manage T3 Code projects, select a workspace for a thread, inspect project files through T3, or update project metadata.
---

# T3 Code Project Control

Use the `t3 project` command group to inspect and mutate projects known to a running T3 Code server.

## Quick start

```sh
t3 project list
t3 project show <project-id-or-path-or-title>
t3 project add <workspace-path> --title "<title>"
t3 project search <project> "<query>"
t3 project browse <project> .
```

## Targeting rules

- Prefer `project.id` from `t3 project list`.
- Workspace paths are accepted and normalized by the CLI.
- Titles must be exact and unique; if ambiguous, list projects and retry by ID.
- Use `--offline` only for project metadata mutations that intentionally target persisted state without a live server.

## Workflows

### Resolve a project for chat creation

1. Run `t3 project list`.
2. Match by workspace root first, then by title.
3. Use the project ID with `t3 chat new --project <project-id> ...`.

### Add or update a project

```sh
t3 project add <workspace-path> --title "<title>"
t3 project rename <project> "<new-title>"
t3 project remove <project>
```

Only remove a project when explicitly requested.

### Inspect project files through T3

```sh
t3 project search <project> "<query>" --limit 50
t3 project browse <project> <partial-path>
```

Use these when the user wants T3 Code’s server-side project view rather than local filesystem tools.

### Write a project file through T3

```sh
t3 project write-file <project> <relative-path> --content "<contents>"
t3 project write-file <project> <relative-path> --file <local-file>
```

Only write files when the user asked for a project mutation. Prefer repository edit tools for ordinary code edits in the current workspace.

### Configure project metadata

```sh
t3 project set-default-model <project> --payload '{"instanceId":"codex","model":"..."}'
t3 project set-default-model <project> --clear
t3 project set-scripts <project> --payload-file scripts.json
t3 project open <project> --editor cursor
```

## Safety

- Do not remove projects or overwrite scripts/default models without explicit intent.
- Treat `write-file` as destructive: confirm the relative path and source content before use.
- Prefer project IDs in all follow-up commands.
