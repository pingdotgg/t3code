# Keyboard focus

The command palette keeps focus while open. Closing it returns focus to the composer in chat,
or to the previous control on pages such as Settings and Usage. Choosing a workspace focus
command moves to that area instead. Opening Settings focuses Search settings; opening Usage
or Pull Requests moves focus into that page.
While the palette or model picker is open, number shortcuts select its entries instead of
switching threads. Model shortcuts work in Settings as well as the composer.
See [Keybindings](./keybindings.md) to customize these shortcuts.

If you return to typing while a terminal is starting, the composer keeps focus when the terminal
becomes ready. Opening or switching to a terminal explicitly still focuses it.

## Move between workspace areas

On web and desktop, press `F6` or `Shift+F6` to move between the Threads sidebar,
conversation, message input, and visible panels. Navigation wraps around and restores
the last focused control in each area. Settings, Usage and Pull Requests have a page content
area. Hidden areas are skipped. Dialogs and form popups retain focus; a thread context menu
closes when an area command moves focus away.

If your browser takes `F6`, use `mod+Alt+]` and `mod+Alt+[` instead (`mod` is Command
on macOS and Ctrl elsewhere). **Focus Next Workspace Area** and **Focus Previous
Workspace Area** are also in the command palette and can be remapped in Settings > Keybindings.

## Browse threads

Tab enters the sidebar tree once. Up and Down move focus without opening a thread;
Enter opens the focused thread or toggles a group. Right expands a group, then enters
its first child. Left collapses it or returns to its parent. Home and End reach the
first and last visible rows. Show more makes additional history available.

Press `F2` on a row to reach its actions, then use Tab between them. Escape returns
to the row. Search and rename fields retain their normal text editing keys.

Press `Shift+F10` or the Context Menu key on a thread to open its menu. On web, Up and Down
wrap through enabled actions, and Home and End reach the first and last action. Right or Enter
opens a submenu; Left or Escape returns to its parent. Escape at the main menu returns to the
thread. Enter runs the focused action. Desktop uses the system's native context menu.

In the Settings sidebar, Up, Down, Home and End focus sections; Enter opens the focused
section. Tab enters the section list once. Settings search keeps its own result navigation.

## Accessible mode

Choose **Accessible mode** in Settings > General or the command palette. **Auto** uses
desktop screen reader detection. In a browser, choose **On** to enable navigation hints.
**Off** removes the extra hints while retaining labels and keyboard navigation.
The preference applies immediately and is saved on this client.
