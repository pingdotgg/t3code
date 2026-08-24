# Themes and desktop automation

Import T3 Code ThemeFile v1 or VS Code color-theme JSON files from **Settings** →
**Appearance**. The desktop app can also import and activate a theme from the command line:

```bash
t3code --theme-file=/absolute/path/to/theme.json
```

Use the `--theme-file=<path>` form when T3 Code is already running. Reapplying a theme with the
same ID updates the installed theme instead of creating a duplicate, which makes the command safe
for desktop theme-manager hooks. Files larger than 256 KiB are rejected.

## Omarchy

Omarchy generates a complete VS Code color theme from its canonical `colors.toml` palette at
`~/.local/state/omarchy/current/theme/vscode-theme.json`. Use that generated file rather than
`vscode.json`, which only identifies a marketplace extension.

For example, save this hook script somewhere in your home directory:

```bash
#!/bin/bash

theme_file="$HOME/.local/state/omarchy/current/theme/vscode-theme.json"
[[ -f $theme_file ]] || exit 0

t3code --theme-file="$theme_file" >/dev/null 2>&1 &
```

Then install it through Omarchy's supported hook interface:

```bash
omarchy hook install theme-set /path/to/the/script
```

The command opens T3 Code if it is not already running. When it is running, Electron forwards the
request to the existing window and exits the second process.
