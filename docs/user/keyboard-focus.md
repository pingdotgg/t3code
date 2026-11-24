# Keyboard focus

The command palette keeps focus while open. Closing it returns focus to the composer in chat,
or to the previous control on other pages. Choosing a workspace focus command moves to that
area instead. Opening Pull requests moves focus into that page.
While the palette or model picker is open, number shortcuts select its entries instead of
switching threads. Model shortcuts work in Settings as well as the composer.
See [Keybindings](./keybindings.md) to customize these shortcuts.

If you return to typing while a terminal is starting, the composer keeps focus when the terminal
becomes ready. Opening or switching to a terminal explicitly still focuses it.

## Move between workspace areas

On web and desktop, press `F6` or `Shift+F6` to move between the Threads sidebar,
conversation, message input, and visible panels. Navigation wraps around and restores
the last focused control in each area. Pull requests has a page content area. In Settings,
`F6` moves between the section list and the open section. Hidden areas are skipped. Other
dialogs and form popups retain focus; a thread context menu closes when an area command
moves focus away.

In a browser, plain `F6` may move to the browser's own toolbar. Use `mod+F6` and
`mod+Shift+F6` instead (`mod` is Command on macOS and Ctrl elsewhere). **Focus Next
Workspace Area** and **Focus Previous Workspace Area** are also in the command palette and
can be remapped in Settings > Keybindings.

## Browse threads

Tab moves through each thread and its buttons. Up and Down also move between threads
without opening them; Enter opens the focused thread or toggles a group. Right and Left
expand and collapse groups. `F2` renames the focused thread.

Press `Shift+F10` or the Context Menu key to open the focused thread's menu. Use the arrow
keys to move through it, Enter to choose, and Escape to close it.

The Settings section list works the same way: Tab moves through each section, Up and Down
also move between sections without opening them, and Enter opens one.

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
