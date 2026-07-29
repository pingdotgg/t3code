# Threads in the same checkout

The sidebar groups active threads by checkout. Threads that use the same Git
worktree appear in one card, and threads that use a project's main checkout
share a card as well.

Each conversation keeps its own messages, turns, approvals, and plan. Resources
that belong to the checkout are shared across the card:

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
