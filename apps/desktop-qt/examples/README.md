# Shell examples

Each folder is a complete rice: a `shell.qml` layout composed from the
`T3.Bricks` module and a `theme.json` in the web app's theme format (plus the
shell-only `window`, `radius` and `fonts` keys). Copy one into your config dir
and the app reloads on save:

```sh
cp examples/glass/*.* ~/.config/t3code/
```

| Example     | Idea                                                                |
| ----------- | ------------------------------------------------------------------- |
| `minimal`   | The default layout with the title bar moved to the bottom.          |
| `dashboard` | Warm light theme, tab strip on top, every brick in a rounded card.  |
| `glass`     | Transparent window for compositor blur, big clock, floating panels. |
| `terminal`  | Status bar with clock and counts, mono type, sharp corners.         |

What you can reach from `shell.qml`: the bricks (`TitleBar`, `Sidebar`,
`SettingsNav`, `Workspace`, `GitActions`, `WebSurface`, `Composer`,
`RightPanel`, `Notifications`, `ContextMenuHost`, `ShellErrorOverlay`), the
themed controls (`ShellButton`, `ShellComboBox`, `ShellTextField`, `ShellMenu`,
`ShellMenuItem`), and the `T3.Shell` singletons: `Shell.state.<key>` for
everything the page publishes, `Shell.dispatch(action, payload)` to act,
`Theme.color(role, fallback)` / `Theme.radius` / `Theme.fontUi` /
`Theme.fontMono`, and `Runtime.reload()`.

A broken `shell.qml` never locks you out: the built-in shell takes over with
the error shown in an overlay.
