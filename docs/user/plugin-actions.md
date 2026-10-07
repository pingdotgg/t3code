# Plugin actions

A trusted local plugin can add actions to the command palette, the thread
menu and the composer's slash menu. Picking one runs the plugin's code right
away, as your OS user. It does not write a prompt or start an agent turn, so
only enable plugins you trust.

## Offering an action

In the plugin's `t3-plugin.json`, add `"actions"` to `capabilities`, set
`"proposedApi": true`, and declare up to 16 actions in `actions`. Each has a
`name` (lowercase letters, digits and dashes; also its slash command), a
`title`, an optional `description`, a `target` and the `placements` where it
appears:

```json
{
  "capabilities": ["actions"],
  "proposedApi": true,
  "actions": [
    {
      "name": "deploy",
      "title": "Deploy this branch",
      "target": "thread",
      "placements": ["command-palette", "thread-menu", "composer-slash"]
    }
  ]
}
```

The plugin answers by registering
`context.proposed.handle("action:<name>", handler)`. The handler receives
`{ action, target }`, where `target` is one of:

- `{ kind: "environment" }`
- `{ kind: "project", projectId, workspaceRoot }`
- `{ kind: "thread", threadId, projectId, cwd, branch }`, where `cwd` is the
  thread's worktree or its project's folder

Return `{ message }` to show the user a short result, or throw to report a
failure. An action that does not finish within 30 seconds fails.

## Where actions appear

Plugins are added, consented to and enabled from an administrative connection,
as described in [Plugin tools](./plugin-tools.md). Listing actions never
starts the plugin; the first action you pick does.

An action appears only where its target is known:

- **Command palette**: on web and desktop, environment actions, plus project
  and thread actions for the project or thread you are in. On mobile with a
  hardware keyboard, the palette shows actions for the open thread's
  environment.
- **Thread menu**: thread actions for that thread, from the sidebar or the
  chat header on web and desktop, and under **Plugin actions** in a thread's
  long-press menu on mobile.
- **Slash menu**: type `/` at the start of a line. In an open thread you see
  that thread's actions; in a new, unsent thread only environment and project
  actions appear. Picking one removes the typed command from your message and
  leaves the rest of the message as it was.

The result appears as a toast on web and desktop, or an alert on mobile.

## When an action is refused

Actions disappear as soon as their plugin is disabled, removed or no longer
able to run. If you picked an action from a list that changed in the meantime,
for example because the plugin was enabled again, it is refused instead of
running against the new version. Open the menu again and pick it from the
current list.

If an environment's plugins declare more than 128 actions, the plugins that do
not fit are left out whole and their actions cannot run. Disable a plugin you
do not need to bring the others back.
