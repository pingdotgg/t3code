# Keyboard focus

Navigate T3 Code's workspace, sidebar, and settings entirely from the keyboard on web and desktop. See [Keybindings](./keybindings.md) to customize shortcuts.

## Move between workspace areas

Press `F6` or `Shift+F6` to cycle between visible workspace areas—the Threads sidebar, conversation, composer, and open panels (or the section list and content pane in Settings). Each area remembers its last focused control, and hidden areas are skipped.

In a web browser, plain `F6` may focus the browser toolbar. Use `mod+F6` and `mod+Shift+F6` instead (`Cmd` on macOS, `Ctrl` elsewhere), or run **Focus Next / Previous Workspace Area** from the command palette.

## Browse threads and settings

- `Tab`: Moves through each thread row and its actions.
- `Up` / `Down`: Moves between threads (or Settings sections) without opening them.
- `Enter`: Opens the focused thread or toggles a group.
- `Right` / `Left`: Expands and collapses groups.
- `F2`: Renames the focused thread.
- `Shift+F10` (or Context Menu key): Opens the focused thread's menu (`Esc` closes it).

## Focus behavior

- Closing the command palette returns focus to the composer in chat (or the previous control elsewhere).
- While the command palette or model picker is open, number shortcuts select its entries instead of switching threads.
- If you resume typing in the composer while a terminal is starting, the composer keeps focus when the terminal finishes loading.
