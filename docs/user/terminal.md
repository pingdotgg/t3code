# Terminal

Every thread has a terminal drawer below the chat. Press `mod+j` (`terminal.toggle`) to open or
hide it. With a shell focused, `mod+d` splits it, `mod+shift+d` splits it vertically, `mod+n` adds
a tab, and `mod+w` closes the active shell. Shells start in the thread's worktree when it has one,
otherwise in the project root, and keep running while the drawer is hidden.

## Pinning a drawer

By default each thread has its own drawer and its own shells. The pin icon at the end of the
drawer's toolbar cycles through three states:

- **Off.** The thread's own drawer.
- **Pinned to project.** Every thread in this project opens this drawer with `mod+j`. Its shells,
  tabs, splits, and height follow you from thread to thread.
- **Pinned for all projects.** Every thread in the environment opens this drawer, whatever project
  it belongs to. A project pin elsewhere is shadowed until you unpin.

Click once to pin to the project, again to pin for all projects, and a third time to unpin. New
shells in a pinned drawer start where the pinned thread runs. Links you click in it still open in
the preview of the thread you are looking at. Unpinning hands each thread its own drawer back, and
the shells stay with the thread that owned them. Deleting the pinned thread also unpins it. Pins are
remembered per device.

Terminals opened as right-panel tabs always belong to their thread, and the mobile app opens a
thread's own terminals regardless of any pin.

## Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.
