# Keybindings

Customize keyboard shortcuts in **Settings → Keybindings** on web and desktop. That page lists every available command ID and default binding.

To free a default shortcut, choose **Unassign** from its row menu (**Reset to default** restores it).

> Note: `mod` means `Cmd` on macOS and `Ctrl` on Windows and Linux.

## Common composer shortcuts

| Action                      | Default           | Notes                                                              |
| --------------------------- | ----------------- | ------------------------------------------------------------------ |
| Start / finish dictation    | `mod+shift+d`     | `Esc` discards. See [Voice input](./voice-input.md).               |
| Opposite queue/steer action | `mod+Enter`       | Uses the non-default follow-up behavior while a turn runs.         |
| Start thread in background  | `mod+Alt+Enter`   | Also `mod+Enter` in a new thread; opens a fresh draft immediately. |
| Send first queued message   | `mod+Shift+Enter` | Steers if running, or starts a turn if stopped.                    |
| Pick model                  | `mod+shift+m`     | `mod+shift+up/down` switches providers inside the picker.          |
| Pick host / environment     | `mod+shift+h`     | Bind **Composer: Cycle Host** to step without a menu.              |
| Pick effort                 | `mod+shift+e`     | Bind **Increase/Decrease Effort** to step without a menu.          |
| Pick permissions            | `mod+shift+a`     |                                                                    |
| Pick workspace mode         | `mod+shift+x`     | `mod+shift+l` reuses the previous worktree directly.               |
| Pick Git branch             | `mod+shift+g`     |                                                                    |

Configure whether `Enter` sends or requires `mod+Enter` in **Settings → Chat → Send shortcut** (`Shift+Enter` always inserts a newline).

In the model picker, use `Left`/`Shift+Tab` to move to the provider list, `Right` to return to search or move into effort levels, and `Up`/`Down`/`Enter` to select.

## Copy pull request and thread references

- `mod+shift+c`: Copies the open PR's URL (or copies a thread chip link when no PR is open).
- `mod+shift+k`: Copies the open PR's `#number`.

Remap under **Copy Link or Thread** and **Copy Number** in **Settings → Keybindings**.

## Find

- **Current thread** (`chat.find`, default `mod+f` outside terminals/previews): Searches all messages and plans in the thread (requires an up-to-date server). Use `Enter` / `Shift+Enter` to step through matches and `Esc` to close.
- **Diffs** (`mod+f` inside a diff or PR Code tab): Searches all loaded files in the diff, unfolding matching files. Not configurable. Very large uncommitted diffs only search files loaded so far.
- **Browser page** (`preview.find`, default `mod+f` in a desktop browser tab): Searches the open page. If a page handles `mod+f` itself, use the browser's **⋮** menu. Not supported in web clients or streamed browser tabs.

## Hardware keyboards on iPad and Android

- **iPad**: `Cmd+1`–`Cmd+9` open the first nine visible threads; `Cmd+K` opens the command palette (prefix with `>` for actions only); `Cmd+Shift+H` cycles host on a new thread. `Return` sends (`Shift+Return` for newline; `Cmd+Return` for opposite follow-up). Change Return behavior in **Settings → Keyboard**.
- **Android**: Same composer Return behavior using `Ctrl` instead of `Cmd`. The on-screen keyboard's Return always inserts a newline.

## Edit the configuration file

Keybindings are stored on the environment's machine at `~/.hyakki/userdata/keybindings.json` as a JSON array:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

New default bindings are added on startup without overwriting customized commands. Invalid rules are ignored; an unparseable file falls back to defaults.

### Rule shape and key syntax

Each rule requires `key` and `command`, plus an optional `when` condition. Project scripts use `script.{id}.run` (e.g. `script.test.run`).

Join modifiers and keys with `+` (`mod`, `cmd`/`meta`, `ctrl`/`control`, `alt`/`option`, `shift`).

### When conditions

Available context keys: `terminalFocus`, `terminalOpen`, `previewFocus`, `previewOpen`, `rightPanelOpen`, `modelPickerOpen`, `usagePageOpen`, `composerFocus`, `draftThreadRoute`, `turnRunning`, `composerEmpty`, `editableFocus`, `isWeb`, `isDesktop`. Unknown keys evaluate to `false`.

Combine with `!`, `&&`, `||`, and parentheses:

```json
{ "key": "mod+j", "command": "terminal.toggle", "when": "terminalOpen && !terminalFocus" }
```

> Tip: `mod+1`–`mod+9` default to `isDesktop` so they don't hijack browser tabs. Remove that condition in Settings if you want thread jumps on web.

## Precedence

The last matching rule in `keybindings.json` wins, even across different commands. Place more specific rules after general ones.

## Commands with special behavior

- `thread.stop`: Interrupts the running turn (unbound by default).
- `thread.regenerateTitle`: Regenerates the focused thread's title (unbound by default).
- `thread.undo` (`mod+z`): Undoes recent sidebar actions (unpin, settle, snooze, archive, discard draft) within 5 seconds, including consecutive actions of the same kind.
- `navigation.back` (`mod+[`) / `navigation.forward` (`mod+]`): Moves through visited pages.
- `chat.new` / `chat.newLocal` / `chat.newWithoutProject` (`mod+alt+n`): Start new threads using your [new-thread defaults](./thread-sidebar.md#start-a-thread) or [without a project](./thread-sidebar.md#start-without-a-project).

## Reserved and platform shortcuts

- `mod+w` (desktop): Closes the focused terminal or active right-panel tab without closing the window. On web, browsers intercept `mod+w`—rebind `rightPanel.close` and `terminal.close` (e.g. `alt+w`).
- `mod+shift+t`: Reopens the last closed panel tab (files, diffs, PRs, browsers, devices) in order. Browser tabs reopen as fresh sessions. Rebind on web if your browser intercepts it.
- Keep `!terminalFocus` when remapping shortcuts that shouldn't intercept terminal input. `sidebar.toggle` ignores `Ctrl+B` inside terminals so `tmux` keeps its prefix (`Cmd+B` still works on macOS).

## Desktop quit shortcut

`Cmd+Q` (macOS) or `Ctrl+Q` (Windows/Linux) defaults to **Hold** mode: hold for 1.2 seconds or press twice within 500 ms. Change this in **Settings → General → Confirmations → Quit shortcut** to **Direct** or **Double press**. Quitting from the application menu always exits immediately.
