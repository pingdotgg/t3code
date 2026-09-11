# Threads in the same checkout

The sidebar and mobile Home and thread navigation lists group threads by checkout.
Threads that use the same Git worktree appear together, and threads that use a
project's local checkout share a group. Checkouts on different computers stay
separate. An active conversation keeps its settled or snoozed siblings visible.
Each thread keeps its own rename, pin, snooze, settle, and navigation actions.
On web, right-click a checkout heading for actions on all its conversations.

Each conversation keeps its own messages, turns, approvals, and plan. Terminal sessions are shared across web, desktop, and mobile. On web and desktop,
resources that belong to the checkout are shared across the group:

- terminal sessions and terminal layout
- preview tabs
- open files and Git diff state
- the checkout's current branch and pull request

Switching between sibling threads therefore keeps a running dev server, browser
preview, and workspace panels in place. Archiving or deleting one sibling does
not stop those resources while another sibling remains. Removing the final
thread closes the checkout-owned terminal resources.

Use `chat.newInWorktree` (default: `mod+t`) to start another conversation in the
current checkout. `chat.new` keeps the active thread's branch/worktree setup,
while `chat.newLocal` follows the configured default for a new environment.

See [Keybindings](./keybindings.md) to customize these shortcuts.
