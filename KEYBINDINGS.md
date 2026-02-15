# Keybindings

T3 Code reads keybindings from:

- `~/.t3/keybindings.json`

Schema source of truth:

- [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts)
- [`packages/contracts/src/server.ts`](packages/contracts/src/server.ts)

Server-side parsing/default resolution/merging:

- [`apps/server/src/keybindings.ts`](apps/server/src/keybindings.ts)
- [`apps/server/src/wsServer.ts`](apps/server/src/wsServer.ts)

The file must be a JSON array of rules:

```json
[
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+shift+d", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+shift+o", "command": "chat.new" },
  { "key": "mod+o", "command": "editor.openFavorite" }
]
```

## Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored. Invalid config files are ignored. Warnings are logged by the server.

## Available Commands

- `terminal.toggle`: open/close terminal drawer
- `terminal.split`: split terminal (in focused terminal context by default)
- `terminal.new`: create new terminal (in focused terminal context by default)
- `chat.new`: create a new chat thread for the active project
- `editor.openFavorite`: open current project/worktree in the last-used editor

## Key Syntax

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

## `when` Conditions

Currently available context keys:

- `terminalFocus`
- `terminalOpen`

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

## Defaults

Built-in defaults are resolved on the server and sent to the web client via `server.getConfig`:

- `terminal.toggle`: `mod+j`
- `terminal.split`: `mod+d` when `terminalFocus`
- `terminal.new`: `mod+shift+d` when `terminalFocus`
- `chat.new`: `mod+shift+o`
- `editor.openFavorite`: `mod+o`

If you define any rules for a command, the default rule for that command is removed on the server.

## Server-Resolved Payload

`~/.t3/keybindings.json` is parsed and compiled on the server. The web client receives resolved rules and does not parse raw keybinding strings.

Resolved rule payload fields:

- `command`
- `shortcut`
- `whenAst` (optional)

See:

- [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts)
- [`apps/server/src/keybindings.ts`](apps/server/src/keybindings.ts)
- [`apps/server/src/wsServer.ts`](apps/server/src/wsServer.ts)

## Precedence

- Rules are evaluated in array order.
- For a key event, the last rule where both `key` matches and `when` evaluates to `true` wins.
- That means precedence is across commands, not only within the same command.
