# Terminals

A thread's terminals start in its workspace. Threads grouped in a
[Task](./thread-sidebar.md#tasks) share terminals with the task page; new terminals
start in the primary project's workspace. Switching between members keeps the
same terminals running. Changing the primary project affects new terminals, while
existing terminals retain their working directory and process. Agent commands
still run in the member thread's checkout.

Project script controls in a task or member thread list, edit, and run the primary
project's scripts. Those scripts use the primary project's workspace and runtime
environment, including when started with a keyboard shortcut. Worktree setup
still belongs to the individual thread's project.

Archiving or deleting a member leaves the task's shared terminals available.
Archiving or deleting the task closes them; restoring a task does not restart its
previous terminal processes.

## Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.
