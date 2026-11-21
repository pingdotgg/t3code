# Terminal

## Choose a shell

Set `LATHE_TERMINAL_SHELL` in the environment that launches the Lathe server
to choose the executable used for new terminals. Use an executable name or its
full path, without surrounding quotes or command-line arguments. An unset or
blank value keeps the platform default. If the executable cannot be started,
Lathe tries its usual fallback shells.

On Windows, to use Git Bash from a standard Git for Windows installation, run
this in PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('LATHE_TERMINAL_SHELL', 'C:\Program Files\Git\bin\bash.exe', 'User')
```

Fully quit Lathe, then reopen it from the Start menu and create a new terminal.
If the app still inherits the old environment, sign out of Windows and sign in
again. Git Bash starts as an interactive login shell. Use `bin\bash.exe`, not
`git-bash.exe`, which launches a separate terminal window.

To restore the default, remove the variable with the same command using `$null`
as its second argument, then restart Lathe.

This setting belongs to the machine hosting the server, including when you
connect from another device. It does not change provider-run commands or the
shell used by automatic project setup and settle scripts.

## Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. Lathe removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when Lathe restores saved terminal
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

## Sign in from a terminal

Commands that open a browser, such as `gh auth login`, `codex login`, or
`claude auth login`, run on the environment, where there is no browser to open.
When one asks for a browser, Lathe shows a banner above that terminal with the
link instead. Choose **Open** to open it on the device you are using, or **Copy**
it into another browser.

Sign-ins that finish on a `127.0.0.1` or `localhost` page are returning to the
command's own listener on the environment, which your browser cannot reach from
another device.

In the desktop app, nothing more is needed. While the banner is showing, Lathe
stands in for that listener on your computer, so the sign-in can end in any
browser here: the in-app browser, or the one **Open** or **Copy link** took you
to. The final page confirms the result is on its way, and the command in the
terminal continues. If the port the command chose is already in use on your
computer, the banner falls back to the return URL field below.

In a web browser or on mobile, that final page does not load. Copy its full
address, including everything after `?`, into the banner's return URL field and
choose **Continue**. Lathe delivers it to the command waiting in the terminal.
Some sign-ins, such as `az login`, post their result to that page instead of
putting it in the address, so there is nothing to copy; the banner says so. Open
the link from the desktop app instead, or use the command's device-code option
(for example `az login --use-device-code`).

Device-code sign-ins finish on the provider's website and need nothing pasted.
Watch the terminal output to confirm the command finished. Dismissing the banner
drops the link; run the command again to get a new one. A link is valid for five
minutes.

## fish

Lathe starts fish with `no-query-term`, avoiding startup waits for terminal
replies. This disables optional fish features that depend on those replies.
Lathe's exported `fish_features` also hides any universal flags you set with
`set -U fish_features`.

To preserve those flags or enable queries with `query-term`, include them in
`fish_features` in the environment that launches Lathe. A shell export applies
when you launch Lathe from that shell; it does not configure a desktop app
launched from the Dock or Finder. Enabling queries can restore the startup wait.
