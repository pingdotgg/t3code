# Archive

Archiving removes a thread from active thread lists without deleting its conversation history. You
can browse archived threads, restore them with **Unarchive**, or permanently remove them with
**Delete**.

Settling is different from archiving. A settled thread remains live in the thread list's **Settled**
section and can return to the active list when you un-settle it or new work begins. Archiving removes
the thread from the live thread list and moves it to Archive instead.

To open the archive:

- In the web or desktop app, open **Settings** → **Archive**.
- In the mobile app, open **Settings** → **Archived Threads**.

On web and desktop, searching Settings for **Archived threads** also opens Archive and focuses the
archive search field.

## Find an Archived Thread

Archived threads are grouped by project. Project groups start collapsed so large archives remain
easy to scan. Expand a project to see each thread's relative **Archived** and **Created** times.

The archive includes every configured environment, including environments that currently have no
active projects but still contain archived threads. On web and desktop, project headings identify
their environment when more than one is configured. A single remote environment is also labeled,
while a single primary environment remains implicit. Mobile shows environment labels and can
filter the archive to one environment.

Use search to filter thread titles across all projects. Search is case-insensitive and supports
multiple words. It shows titles matching any search term, prioritizes exact phrase matches, then
titles matching every term, and opens matching project groups while the search is active.

The default order is newest archived thread first. On web and desktop, select **Archived** or
**Created** in an expanded project heading to change the sort field or reverse its direction. On
mobile, use the header options to choose the environment and sort order.

## Restore or Delete a Thread

On web and desktop, hover over or focus a thread row to reveal **Unarchive** and **Delete**. The same
actions are available from the row's context menu.

On mobile, swipe a thread row or open its long-press menu.

- **Unarchive** restores the thread to the active thread list.
- **Delete** permanently clears the thread and its conversation history.

Web and desktop deletion follows the **Confirm thread deletion** setting. Mobile deletion always
uses its guarded confirmation flow.

Controls are temporarily disabled while the same thread is already being changed. If an action is
already in progress, or if an operation cannot be completed, T3 Code reports that result instead of
starting a conflicting action.

## Act on a Project

Open a project heading's actions menu to **Unarchive all** or **Delete all** archived threads in
that project.

When search is active, these actions become **Unarchive matching** and **Delete matching** and apply
only to the visible matches. Clear the search before using a project action if you want it to apply
to the whole project.

Bulk unarchive always asks for confirmation. Bulk delete follows the web or desktop deletion
setting and remains explicitly guarded on mobile. If only part of a bulk operation succeeds, T3
Code reports the completed, failed, and skipped work without claiming that every thread failed.
