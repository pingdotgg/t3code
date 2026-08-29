# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

You can attach images up to 10 MB. On servers that support file uploads, web and desktop can also
attach text files, PDFs, ZIP archives, and other files. Each file can be up to the limit advertised
by the server, capped at 50 MB. Each message can contain up to eight attachments in total. Files
upload directly to the environment, where your agent can read, copy, or edit them by their file path.

On web and desktop, attachments upload as soon as you add them. The send button becomes available
after every upload finishes. Failed uploads can be retried or removed. On mobile, attachments are
currently limited to images.

If you reload before a file finishes uploading, the draft keeps the file's name and shows **Attach
again** next to it. Attach the file again or remove it, then send.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

On mobile, the model picker shows each OpenCode model's upstream provider, such as Anthropic,
GitHub Copilot, or OpenCode Zen, beneath its name. Search by that provider name to narrow the list
when starting a thread or changing an existing thread's model.

## Activity and task progress

On web and desktop, the running timer stays attached to the composer while the agent works,
including when you scroll through earlier messages. If the turn has tasks, the timer appears in
the Tasks tab and expanded task list. The timer stays on the left, followed by the current task and
its progress. Click the banner to expand or collapse the task list. The summary stays available
while the agent works. Without tasks, the banner shows only the timer. The timer disappears when
the turn finishes.

While messages load or sync, that status temporarily replaces the timer. You can still
expand any tasks already loaded. Once syncing finishes, the timer reflects the turn's
original start time. Long task lists scroll beneath their header, with a fade at each
edge that has more content.

Notices stack above the activity row. Dismissing a notice keeps the timer and task progress visible.
You can dismiss a failed server update and retry later in **Settings → Connections**.
If another attempt fails, its notice appears again.

Tool calls and status updates share expandable activity groups in the conversation. Task updates
refresh the task list without adding separate "Plan updated" entries. Errors and agent links stay
visible outside collapsed groups.

## Prompt stash

Use the default shortcut, `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux, to stash the current
prompt and its attachments after all file uploads finish. Restore the entry later from the stash
menu. Stashes that contain files must be restored in the environment where those files were
uploaded. Stashed files stay uploaded on the server for 24 hours. If you restore an entry after
that, the file comes back with **Attach again** next to it. Attach the file again or remove it, then
send.

The stash drawer closes automatically when you delete its last entry.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

On mobile, these menus are available on the **New task** screen before you start a thread. They
use the skills and commands from the selected environment and provider.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, T3 Code hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. T3 Code opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.
