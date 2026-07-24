# Storage directories

New T3 Code installations keep configuration, durable data, machine state,
disposable caches, and process-lifetime files in separate directories.

On Linux, the default roots are:

| Purpose       | Default                                                       |
| ------------- | ------------------------------------------------------------- |
| Configuration | `${XDG_CONFIG_HOME:-$HOME/.config}/t3code`                    |
| Data          | `${XDG_DATA_HOME:-$HOME/.local/share}/t3code`                 |
| State         | `${XDG_STATE_HOME:-$HOME/.local/state}/t3code`                |
| Cache         | `${XDG_CACHE_HOME:-$HOME/.cache}/t3code`                      |
| Runtime       | `$XDG_RUNTIME_DIR/t3code`, with a per-user temporary fallback |

Settings and keybindings live in the configuration directory. Attachments and
worktrees live in the data directory. The SQLite database, identity, secrets,
and logs live in the state directory. Provider caches and desktop browser
artifacts live in the cache directory. Live-server discovery state lives in the
runtime directory.

The effective paths for the connected server are shown under **Settings →
Diagnostics → Storage Locations**.

## Overrides

Each root can be overridden independently:

- `T3CODE_CONFIG_DIR`
- `T3CODE_DATA_DIR`
- `T3CODE_STATE_DIR`
- `T3CODE_CACHE_DIR`
- `T3CODE_RUNTIME_DIR`

This lets a machine-local environment point the configuration root at a
dotfiles checkout while keeping durable data, state, caches, and runtime files
in host-local directories.

`T3CODE_HOME` and `--base-dir` are legacy compatibility controls. They select
the old unified layout beneath the supplied directory and cannot be combined
with the granular overrides.

Use `--storage-layout xdg` to force the platform-native split layout, even when
an initialized legacy installation exists. Use `--storage-layout legacy` to
force the default legacy tree under `~/.t3`, even when it has not been
initialized. These values override automatic layout selection; `xdg` cannot be
combined with `T3CODE_HOME` or `--base-dir`, and `legacy` cannot be combined
with granular directory overrides.

## Existing installations

If T3 Code finds initialized storage under `~/.t3`, it continues using that
layout. Startup does not copy, move, delete, or automatically switch any data.
An explicit migration workflow will be handled separately.
