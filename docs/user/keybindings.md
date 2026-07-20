# Keybindings

T3 Code reads keybindings from:

- `~/.t3/keybindings.json`

The file must be a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

See the full schema for more details: [`packages/contracts/src/keybindings.ts`](../../packages/contracts/src/keybindings.ts)

## Defaults

```json
[
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+n", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+w", "command": "terminal.close", "when": "terminalFocus" },
  { "key": "mod+shift+j", "command": "preview.toggle" },
  { "key": "mod+r", "command": "preview.refresh", "when": "previewFocus" },
  { "key": "mod+l", "command": "preview.focusUrl", "when": "previewFocus" },
  { "key": "mod+=", "command": "preview.zoomIn", "when": "previewFocus" },
  { "key": "mod+-", "command": "preview.zoomOut", "when": "previewFocus" },
  { "key": "mod+0", "command": "preview.resetZoom", "when": "previewFocus" },
  { "key": "mod+k", "command": "commandPalette.toggle", "when": "!terminalFocus" },
  { "key": "mod+n", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+t", "command": "chat.newSameWorktree", "when": "!terminalFocus" },
  { "key": "mod+shift+o", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+n", "command": "chat.newLocal", "when": "!terminalFocus" },
  { "key": "mod+o", "command": "editor.openFavorite" }
]
```

For most up to date defaults, see [`DEFAULT_KEYBINDINGS` in `apps/server/src/keybindings.ts`](../../apps/server/src/keybindings.ts)

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored. Invalid config files are ignored. Warnings are logged by the server.

### Available Commands

- `terminal.toggle`: open/close terminal drawer
- `terminal.split`: split terminal (in focused terminal context by default)
- `terminal.new`: create new terminal (in focused terminal context by default)
- `terminal.close`: close/kill the focused terminal (in focused terminal context by default)
- `preview.toggle`: open/close the in-app browser preview panel (desktop app only)
- `preview.refresh`: reload the active preview tab (in focused preview context by default)
- `preview.focusUrl`: focus the URL input of the preview panel (in focused preview context by default)
- `preview.zoomIn`: zoom the preview viewport in one step (in focused preview context by default)
- `preview.zoomOut`: zoom the preview viewport out one step (in focused preview context by default)
- `preview.resetZoom`: reset the preview zoom to 100% (in focused preview context by default)
- `commandPalette.toggle`: open or close the global command palette
- `chat.new`: create a new chat thread using the configured default workspace mode
- `chat.newSameWorktree`: create a new chat thread in the active thread's checkout/worktree
- `chat.newLocal`: create a new chat thread in the active project's main checkout
- `editor.openFavorite`: open current project/worktree in the last-used editor
- `script.{id}.run`: run a project script by id (for example `script.test.run`)

### Key Syntax

Supported modifiers:

- `mod` (`cmd` on macOS, `ctrl` on non-macOS)
- `cmd` / `meta`
- `ctrl` / `control`
- `shift`
- `alt` / `option`

Examples:

- `mod+j`
- `mod+shift+d`
- `ctrl+l`
- `cmd+k`

### `when` Conditions

Currently available context keys:

- `terminalFocus`
- `terminalOpen`
- `previewFocus`
- `previewOpen`

Supported operators:

- `!` (not)
- `&&` (and)
- `||` (or)
- parentheses: `(` `)`

Examples:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "terminalFocus || terminalOpen"`

Unknown condition keys evaluate to `false`.

### Precedence

- Rules are evaluated in array order.
- For a key event, the last rule where both `key` matches and `when` evaluates to `true` wins.
- That means precedence is across commands, not only within the same command.
