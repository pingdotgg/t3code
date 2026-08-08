# Session grid

The session grid gives you a live, project-focused workspace for your unsettled threads. Open **Session grid** from the bottom of the sidebar, or search for **Open session grid** in the command palette.

Choose a project from **Grid projects** in the left panel. T3 Code remembers the selection in the page URL, so reload, back and forward navigation, and shared links keep the same project. When no project is selected yet, the grid opens the first project with unsettled work.

Right-click a project, or use its **Project actions** button, to open the same compact menu. From there you can show its grid, start a new session, copy its path, reveal settled sessions, or remove the project. Removing a project always asks for confirmation: it removes the project entry and its conversation history, but never deletes the project files on disk. When one logical project groups multiple environments, the menu lets you remove a single environment entry or every grouped entry explicitly.

## What appears in the grid

The grid shows threads that are still part of your working queue, including pinned threads, running agents, approval and input requests, failed runs, completed threads that have not been settled, and snoozed threads.

Snoozed threads remain visible as quieter panes and provide a **Wake** action, so snooze remains reversible without leaving the grid.

It leaves out:

- settled threads;
- archived threads.

Pane positions remain stable while messages and statuses update. Drag a pane by its header to arrange the project the way you work; T3 Code remembers that order locally.

## Working in a pane

Every spaced pane is the actual thread, not a summary card. It embeds the same chat surface as the full thread, including the virtualized timeline, user and assistant messages, Markdown, tool activity, proposed plans, changed files, live streaming updates, and the complete thread-specific composer. The compact header shows the [generated current subtitle](./thread-subtitles.md), thread status, and branch, plus its environment when a logical project spans more than one environment. Pull request status participates in the same settlement rules used by the sidebar.

Focusing a pane also highlights that thread in the project panel, so the grid and sidebar always show the same active session. Focusing an empty new-thread pane clears the sidebar highlight until that draft becomes a live session.

Use the compact composer at the bottom of a pane exactly as you would in the full thread: drafts, attachments, models, modes, approvals, structured questions, sending, and stopping stay scoped to that thread. Its low-profile editor keeps the model and primary action visible while grouping less-frequent mode and access controls under **More**, reducing vertical space without hiding capabilities. Branch selection and any relevant environment control live in the pane header instead of extending the composer; redundant locked-workspace labels are omitted. Select the thread title or the arrow in its header to open the same chat as the main workspace.

Drag any gap between pane columns or rows to resize the adjacent tracks. The layout stays within the grid, keeps panes large enough to remain usable, and is remembered locally for that project and grid shape. Double-click a resize boundary to reset that axis to equal sizes. Keyboard users can focus a boundary and resize it with the matching arrow keys; hold Shift for a larger step.

Terminal, source-control, and right-panel controls live once in the global grid header. Source control and right-panel surfaces open as a fixed, resizable third workspace column beside the grid rather than inside a session or in an overlay. An open right panel stays open when you move between regular chats and the session grid; settings temporarily use the full workspace without changing that preference. The panel acts on the focused session, while its surfaces remain stored per thread as you move focus around the grid.

A quiet thread that can safely leave the working queue has a **Settle** action in its header. Running threads and threads waiting on approval or input cannot be settled. A snoozed pane has a **Wake** action instead.

Settling removes a thread from the grid. You can bring it back from the settled section in the sidebar.

Use **New thread** in the top bar to add an empty draft pane directly to the selected project’s grid instead of leaving the grid. The draft contains the complete composer, so you can choose the provider, model, interaction mode, environment mode, and attachments before sending. The first send promotes the pane in place to a live session; discard the untouched draft from its header. When the square grid has a spare cell, that cell also becomes a **New session** action with the same behavior. New-thread keyboard shortcuts inherit the selected project.

## Smaller screens

The responsive web view collapses to one full-width chat pane at a time in a vertical list and keeps the project row and primary actions available without hover. The native mobile app continues to use its project-filtered Home list, which is optimized for phone navigation.
