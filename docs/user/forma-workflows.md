# Forma workflows

## Thread header

The compact thread header keeps navigation and high-frequency controls visible without crowding
the workspace:

- Select the project cube to switch projects across environments.
- Select the thread title to switch between active threads in the same project or start a new
  thread.
- Open the ellipsis menu for project actions, editor targets on the local environment,
  source-control actions, Markdown export, copy, fork, archive, and delete.
- Use the panel icon to open or close the tabbed right panel. Browser, terminal, files, diff,
  plans, and component previews remain separate surfaces in that panel.

Remote project actions and source-control operations run on the environment server. “Open in
editor” is intentionally hidden for remote environments because it targets a local desktop
application. The terminal drawer remains available through its keybinding even though its button
is not shown in the thread header.

## Build, Ask, and Plan

Use the mode pill in the composer to choose how the next turn runs:

- **Build** lets the provider implement work normally.
- **Ask** asks the provider to investigate and answer without treating the
  thread as a plan. Ask is shown only for providers that advertise support.
- **Plan** uses the upstream planning mode and plan workflow.

The selected mode synchronizes between Forma web and desktop clients. Sending a
normal turn from the official mobile app clears a stale Ask override.

## Composer controls

The Forma composer keeps writing controls inside the rounded prompt surface and places execution
metadata in a separate row below it.

The footer is ordered from left to right:

1. **Add actions** opens Build, Ask, and Plan choices, image attachment, skills, and any stashed
   prompts.
2. The colored **Build / Ask / Plan** pill shows the active interaction mode.
3. The **model picker** selects the provider model. A provider-instance badge appears only when
   multiple instances of the same provider or a custom identity need disambiguation.
4. Provider-specific traits and the plan-sidebar control follow when available.
5. The final circular action sends while idle, adds to the queue while an agent is running, and
   interrupts a running turn when the prompt is empty.

The metadata row contains the environment, workspace or worktree, branch, access mode, and context
usage. Non-Git projects still expose access mode and context usage. On narrow layouts the
environment and workspace choices combine into one menu, while branch and access controls remain
reachable.

Press **Command-S** on macOS or **Control-S** elsewhere to stash a populated prompt. Use the
**Stashed prompts** row in Add actions—or the same shortcut while the composer is empty—to restore
one later. Stashes can be restored across threads; the menu reports attachments that are still
being saved or could not be preserved.

## Queued turns

Submitting while a thread is busy adds the prompt to a persistent FIFO queue.
The composer shows queued items and lets you remove an item or resume a paused
queue. The queue pauses after an interruption or provider start failure and
survives restarts. A queued prompt is revalidated when it is promoted, including
its attachments and source plan.

## Fork and export

Use a thread’s sidebar or header menu to:

- **Fork** a completed, idle thread into a new thread with cloned durable
  conversation history. Active runtime state, approvals, checkpoints, queue
  items, and archive state are not copied.
- **Export Markdown** to download the conversation, plans, activities, and
  checkpoint metadata in a stable Markdown document.

## Project-local agents

Forma indexes valid project-local skill and command documents. Type `$` to
search provider and project skills, or `/` to search local commands. The menu
labels local sources, expands the selected document before submission, and
skips malformed files without breaking the composer.

## Files and workspace changes

The Files surface supports creating files and folders, renaming entries, and
deleting entries in addition to copy-mention and add-to-chat. All operations
stay within the project root and respect protected paths.

Editable files use content versions. If a file changes on disk after it was
opened, autosave stops and preserves the local draft. Reload accepts the disk
version; Overwrite intentionally saves the draft over it.

## Preview surfaces

Browser Preview and Component Preview are separate right-panel surfaces:

- **Browser Preview** shows a running web application or URL.
- **Component Preview** discovers a configured Storybook/component harness,
  starts and stops its runtime, selects components and scenarios, and attaches
  visual feedback annotations to the composer.

Component Preview routes use the environment session token and remain scoped to
the selected project.

## App icons

Interface settings offers the build default plus Forma Arc, Fluted, Foil, and
Blueprint. Selection updates the favicon immediately and, in desktop builds,
the dock and supported window icons. Reset restores the build-specific default.
