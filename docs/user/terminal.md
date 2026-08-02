# Terminal

T3 Code opens terminal sessions on the connected environment, in the active project's working
directory.

## Choose a shell

Open **Settings → General → Terminal shell** and choose one of these options:

- **System default** uses the connected environment's configured shell.
- **Zsh**, **Bash**, or **Fish** explicitly starts that shell.

The choice is saved on the environment, so it also applies when a web, desktop, or mobile client
opens a terminal there. It affects new and restarted terminals; shells that are already running
continue unchanged.

The selected shell must be installed and available on the environment's `PATH`. If it cannot be
started, T3 Code tries another available shell so the terminal remains usable.
