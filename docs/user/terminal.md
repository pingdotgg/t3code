# Terminal

T3 Code opens terminal sessions on the connected environment, in the active project's working
directory.

## Choose a shell

Open **Settings → General → Terminal shell** and choose one of these options:

- **System default** uses the connected environment's configured shell.
- **Zsh**, **Bash**, or **Fish** explicitly starts that shell. Only shells discovered on the
  connected environment are offered.

The choice is saved on the environment, so it also applies when a web, desktop, or mobile client
opens a terminal there. It affects new and restarted terminals; shells that are already running
continue unchanged.

T3 Code probes the connected environment's `PATH`, so remote environments can show different
choices. If a previously selected shell is later removed, it appears as unavailable until you
choose another option. T3 Code still tries another available shell when opening a terminal so the
terminal remains usable.
