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

## Use Vim keys in chat

On web and desktop, turn on **Settings > Chat > Vim mode**. You can find the switch by
searching for “Vim” in Settings or the command palette. The preference is saved on this device.
Chat opens in **INSERT**. Press `Esc` in the composer to enter **NORMAL**. A block
cursor marks one character in your sent messages or the agent's replies. Use `h`,
`j`, `k`, and `l` to read, or `J` and `K` to jump between messages.

Press `v` to start a selection at the cursor. For example, `vip` selects the current
paragraph and `y` copies it. To copy a paragraph directly from **NORMAL**, use `yip`.
Press `Esc` to leave **VISUAL**, then `i` to return to your draft.
In a read-only subagent conversation, choose **Enter Vim normal mode** to read or copy
messages. Press `Esc` in **NORMAL** to leave navigation.

### Navigate the Threads sidebar

In **NORMAL**, press `gd` to open the sidebar. Focus starts on the current thread
when it is listed, or on the first row.
Use `j` and `k` to browse rows, or `gg` and `G` to reach the first and last visible rows.
Press `l` to expand a group or enter its first child, and `h` to collapse a group or
return to its parent. Press `Enter` to open the focused thread. Moving past the last
row with `j` reaches sidebar actions such as Settings. Press `/` to search threads
and `Esc` to return to the list.

Press `m` on a project, thread, or draft to open its actions. Use `j` and `k` to
choose an action, `l` and `h` to enter or leave a submenu, and `Enter` to run it.
`Esc` closes one menu level. From a sidebar row, `Esc` returns to the conversation
and `i` resumes typing in your draft.

### Chat keys

| Keys                                                                | Action                                                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `h` / `l`, `j` / `k`                                                | Move by character or line. At a message boundary, moving down or up in Normal continues into the next or previous message. |
| `w` / `b` / `e`, `0` / `^` / `$`                                    | Move by word, or to the start, first nonblank character, or end of a line.                                                 |
| `{` / `}`, `J` / `K`, `gg` / `G`                                    | Move by paragraph, scroll smoothly between messages, or scroll to the first or last line of loaded history.                |
| `f` / `F`, `t` / `T` followed by a character                        | Find a character on the line, or stop just short of it. Uppercase searches backward.                                       |
| `PageDown` / `PageUp`, `Ctrl+f` / `Ctrl+b`, `Space` / `Shift+Space` | Page down or up. In Visual, paging extends the selection within the message.                                               |
| `Ctrl+d` / `Ctrl+u`                                                 | Move down or up half a screen. In Normal, `d` / `u` also work.                                                             |
| `v` / `V`                                                           | Select by character or by line. A folded prompt opens for text selection.                                                  |
| `viw` / `vip`, `vaw` / `vap`                                        | Select a word or paragraph. The `a` form includes adjacent whitespace. Use `W` for a whitespace-delimited word.            |
| `vy` / `yy` / `yiw` / `yip`                                         | Copy the character, line, word, or paragraph at the cursor.                                                                |
| `Tab` / `Shift+Tab`, `[` / `]`                                      | Focus controls starting at the message, or switch workspace areas. Press Enter to activate a control.                      |
