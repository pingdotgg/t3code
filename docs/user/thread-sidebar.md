# Working with threads

Use a new thread for a separate conversation with an agent. Group related threads
in a **Task** when they belong to the same piece of work. Choose **New worktree**
when a thread's code changes need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

## Tasks

Choose **New task** from the sidebar or command palette, give it a name, and select
its primary project. A task can start empty and contain threads from different
projects in the same environment. On mobile, **New task** preselects the project
when you are viewing a specific project. From **All projects**, select a project
before creating the task. On web and desktop, choose **Add threads…** from
the task page or its actions to search and select existing threads, then choose
**Add to task**. Threads already in another task move to the selected task.
Use a thread's **Move to task** menu to group it
or move it to another task; **Remove from task** returns it to the ordinary thread
list without changing its conversation or checkout.

**All projects** groups members under their tasks. Selecting a project shows its
threads in a flat list, including members of tasks whose primary project is
elsewhere. Servers without Tasks support continue to show flat thread lists.

Expanded tasks initially show up to six threads in their existing order. Change
**Threads shown per task** in General settings to adjust this limit. **Show all**
reveals the remaining threads and the Settled section, which keeps its own chevron.
**Show less** restores the preview. Each device remembers this choice per task,
even after closing and reopening it. Your current thread and pending local work
remain visible outside the preview; sidebar search also finds hidden threads.

Open a task to edit its details or choose **New thread**. Web and desktop open the
usual draft page; mobile opens the new-thread sheet. Creating from a task selects
that task and its primary project. On web and desktop, the task selector beside the
checkout controls lets you change the task or choose **No task** before sending.
Plain new threads start without a task. Task drafts can use another project in the same environment.
**New thread in this worktree** and **Implement in new thread** keep the source
thread's task and checkout context.

Members share the task's files and terminals, plus browser tabs on web and desktop.
These tools use the primary project's workspace directory. The agent, Git changes,
and diffs still use each thread's own checkout. Changing the primary project changes
the file root and defaults for new tools; existing terminals keep their process and
working directory. See [terminals](./terminal.md).

Pin the task to keep the whole group above active work; members cannot be pinned
individually. Settling a task settles its members together. Running or
queued work, approvals, and questions that require an agent response block the
whole action; idle async questions can be dismissed by settlement. **Un-settle
task** restores member states changed by that settlement, including snoozes whose
deadlines have not passed. Already-settled members and threads subsequently moved
or changed stay as they are. New member activity reopens the task without restoring
other members. Snoozing and waking a task leave member states alone.
An error or completed turn newer than the task's snooze wakes it; an older result
does not interrupt a later snooze.
Inactive tasks with no live members follow the primary project's inactivity
settings; see [settlement settings](#settle-finished-work).

Archiving a task archives its visible members. Restore it from the existing
archived inventory in Settings (the Archive screen on mobile) to restore its
archived members too. Restoring a member of an archived task restores the task.
Deleting a task defaults to **Keep threads**, which removes their membership and
preserves their state, including archived threads. Choose **Delete threads** only
when you also want to delete its conversations.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; **Done** returns to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement, but an old closed or merged pull request does not settle work you
resumed after it closed.

Change these rules in **Settings → General**. They continue to run when your apps
are closed. On web and desktop, choose an environment at the top to change only
its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

On web and desktop, use **Agents** to follow work delegated to subagents.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.
