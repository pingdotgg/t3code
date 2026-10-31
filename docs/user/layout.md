# Tabs, panes and workspaces

Everything you open is a tab: a chat, its terminal, a diff, files, the browser.
Tabs sit in panes, panes stack into columns, and columns run left to right on a
strip. Workspaces stack the strips vertically.

- **New tab:** `mod+t` opens an empty tab that starts a thread in a project you pick,
  or opens a terminal, files, diff, browser, pull request or device for the thread you
  were on, each with its letter key. `mod+n` starts a thread right away. The `+` in a
  chat's notch offers the same; right-click it for a terminal, browser, files or diff
  beside the chat.
- **Split:** `mod+d` opens a new tab in a pane to the right, `mod+shift+d` one below.
  Or drag a tab onto a side of any pane, or onto the window's left or right edge for a
  new column. Inside a terminal, the same keys split the terminal.
- **Terminal and surfaces:** a diff, files, a browser, a terminal or a pull request is a
  tab of its own, named after its thread ("Diff · Fix login"), and moves like any tab.
  `mod+j` puts the thread's terminal below its chat and `mod+alt+b` puts its other tabs
  beside it, or a new tab there when it has nothing open yet; the same keys hide them
  again, still running. A hidden terminal stays in the chat's notch. Closing a chat
  leaves its surface tabs open.
- **Closing:** `mod+w` or a tab's `x` closes any tab. The window's last tab leaves a
  new tab in its place, and an emptied workspace shows the same choices; pick one, use
  `mod+t`, or open a thread from the sidebar.
- **When it doesn't fit:** columns share the window while each stays readable, then
  keep their width and the strip scrolls sideways. Resizing the window never resizes
  columns; it shows more or less of the strip. Swipe sideways with two fingers, or
  hold `mod+alt` and scroll. In the macOS desktop app, **Settings › Layout ›
  Three-finger swipe** moves one column or workspace per flick once macOS's "Swipe
  between pages" is set to three fingers.
- **Moving around:** `mod+alt` with an arrow focuses the next pane; add `ctrl` to move
  the pane instead. Off macOS, use `alt+shift` arrows to focus and
  `ctrl+alt+shift` arrows to move. Hold `mod+alt` for half a second to see the layout
  keys; `mod+/` shows every shortcut.
- **Workspaces and the overview:** `mod+alt+u` and `mod+alt+i` switch workspaces, and
  so does scrolling up or down with `mod+alt` held. Ordinary scrolling stays inside
  the pane, including at the end of a chat. A trackpad swipe with `mod+alt` held
  follows your fingers; a mouse wheel moves one workspace per notch. "Move to a new
  workspace" in a tab's menu starts one, and `mod+alt+o`, a pinch, or resting the
  pointer in the bottom-left corner zooms out to all of them.

Closing a chat tab settles a finished thread (see [Thread sidebar](./thread-sidebar.md)).
The arrangement is saved on each device. **Settings › Layout** sets where the terminal
and side pane open, the tab the side pane starts on, where new tabs go, and what
happens when a pane has no room; a project can override these like its model.
