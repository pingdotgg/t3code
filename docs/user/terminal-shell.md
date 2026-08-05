# Choose the default terminal shell

T3 Code uses an environment-wide shell preference when it opens a new terminal. To change it,
open **Settings** → **General** → **Default terminal shell** and enter either an executable name
available on the environment's `PATH` or an absolute executable path.

For example, on Windows you can enter `pwsh.exe`, `cmd.exe`, or a full path such as
`C:\Program Files\Git\bin\bash.exe`. On macOS and Linux, values such as `zsh`, `bash`, or an
absolute path are supported.

Leave the field empty to use the platform default. Windows prefers PowerShell and falls back to
Windows PowerShell or Command Prompt when needed. macOS and Linux prefer the environment's
`SHELL`, then fall back to common system shells. If a configured shell cannot be started, T3 Code
tries those platform fallbacks instead.

The change applies to terminals opened after the setting is saved; existing terminals keep their
current shell.

## Client availability

The setting is available in the web and desktop clients. Mobile does not currently expose the
control. Because the preference belongs to the connected environment, terminals opened from any
client use the value configured from web or desktop.
