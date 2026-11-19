# Terminal

## Choose a shell

Set `T3CODE_TERMINAL_SHELL` in the environment that launches the Ada server
to choose the executable used for new terminals. Use an executable name or its
full path, without surrounding quotes or command-line arguments. An unset or
blank value keeps the platform default. If the executable cannot be started,
Ada tries its usual fallback shells.

On Windows, to use Git Bash from a standard Git for Windows installation, run
this in PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('T3CODE_TERMINAL_SHELL', 'C:\Program Files\Git\bin\bash.exe', 'User')
```

Fully quit Ada, then reopen it from the Start menu and create a new terminal.
If the app still inherits the old environment, sign out of Windows and sign in
again. Git Bash starts as an interactive login shell. Use `bin\bash.exe`, not
`git-bash.exe`, which launches a separate terminal window.

To restore the default, remove the variable with the same command using `$null`
as its second argument, then restart Ada.

This setting belongs to the machine hosting the server, including when you
connect from another device. It does not change provider-run commands or the
shell used by automatic project setup and settle scripts.

## Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. Ada removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when Ada restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

On iPhone and iPad, long-press the terminal to paste or to choose Select Text.
Select Text shows the visible output, where you can copy text or tap a link.

## fish

Ada starts fish with `no-query-term`, avoiding startup waits for terminal
replies. This disables optional fish features that depend on those replies.
Ada's exported `fish_features` also hides any universal flags you set with
`set -U fish_features`.

To preserve those flags or enable queries with `query-term`, include them in
`fish_features` in the environment that launches Ada. A shell export applies
when you launch Ada from that shell; it does not configure a desktop app
launched from the Dock or Finder. Enabling queries can restore the startup wait.
