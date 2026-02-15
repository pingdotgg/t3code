# Keybindings

T3 Code reads keybindings from:

- `~/.t3/keybindings.json`

The file must be a JSON array of rules:

```json
[
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+shift+d", "command": "terminal.new", "when": "terminalFocus" }
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

Built-in defaults:

- `terminal.toggle`: `mod+j`
- `terminal.split`: `mod+d` when `terminalFocus`
- `terminal.new`: `mod+shift+d` when `terminalFocus`

If you define any rules for a command, the default rule for that command is removed.

## Precedence

- Rules are evaluated in array order.
- Later matching rules win over earlier matching rules for the same command.
