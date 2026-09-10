# Thread workspace

Each thread keeps its own workspace tabs for the conversation, files, terminals, diffs, browser
previews, pull requests, agents, and devices. Switching threads restores that thread's tabs, pane
layout, focused pane, and divider positions.

On desktop-sized web and desktop windows, every surface is a tab in a pane group; there is no
separate right panel. Narrow windows keep tool tabs in a sheet so the conversation remains usable.

Use **Split editor right** in the workspace toolbar to add an empty pane, then use its **+** menu to
choose what opens there. A tab's context menu can copy it into a split, move it into a new split, or
move it to an adjacent pane. Drag tabs within a row to reorder them, onto another tab row to move
them, onto a pane edge to create a split, or onto a pane center to swap pane layouts.

Drag a divider to resize panes, use the arrow keys while its resize handle is focused, or
double-click the divider to restore a 50/50 split. Closing the last tab in a non-root pane collapses
that split. Empty panes show a close button.

## Keyboard navigation

The default pane shortcuts use Vim directions. `mod` means Command on macOS and Control elsewhere.

| Action                                  | Shortcut            |
| --------------------------------------- | ------------------- |
| Split left, down, up, or right          | `mod+shift+h/j/k/l` |
| Focus the pane left, down, up, or right | `mod+alt+h/j/k/l`   |
| Maximize or restore the focused pane    | `mod+shift+enter`   |

Customize any of these under **Settings → Keybindings**. Pane shortcuts do not intercept input while
a terminal is focused.
