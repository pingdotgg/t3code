# Terminal shell

Terminals open with your system's default shell. To choose another, set **Default
shell** in **Settings → General**. T3 Code lists the shells it finds on that
machine: PowerShell 7, Windows PowerShell, Command Prompt, and Git Bash on
Windows, and the shells in `/etc/shells` elsewhere. The same row in a project's
settings overrides the choice for that project.

To use a different shell for one terminal, open the menu next to **New terminal**
in the terminal drawer and pick a shell. On mobile, use **New terminal with…** in
the terminal menu.

A repository can suggest a shell with `terminalShell` in `t3.json`, using a shell
name such as `"pwsh"`, `"powershell"`, `"cmd"`, or `"bash"`. `"bash"` means Git
Bash on Windows.

A setting in T3 Code always wins over `t3.json`: a project override, then the
environment setting, then `t3.json`, then automatic detection. If the chosen
shell can't start, the terminal falls back to the default, and the terminal tab's
tooltip shows which shell is running and which one couldn't start. WSL shells
aren't supported.

# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

## fish

T3 Code starts fish with `no-query-term`, avoiding startup waits for terminal
replies. This disables optional fish features that depend on those replies.
T3 Code's exported `fish_features` also hides any universal flags you set with
`set -U fish_features`.

To preserve those flags or enable queries with `query-term`, include them in
`fish_features` in the environment that launches T3 Code. A shell export applies
when you launch T3 Code from that shell; it does not configure a desktop app
launched from the Dock or Finder. Enabling queries can restore the startup wait.
