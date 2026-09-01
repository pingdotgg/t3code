# Shell examples

Each folder is a complete rice: a `shell.qml` layout composed from the
`T3.Bricks` module and a `theme.json` in the web app's theme format (plus the
shell-only `window`, `radius` and `fonts` keys). Copy one into your config dir
and the app reloads on save:

```sh
cp examples/glass/*.* ~/.t3/shell/
```

| Example     | Idea                                                                                                                                                                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal`   | The default layout with the title bar moved to the bottom, on the web app's own dark palette (`theme.json` here is the page's default theme, so it is the one to copy when a rice should start from stock colours).                                                                                                   |
| `dashboard` | Rosé light theme, icon rail, tab notch on top, and a Dashboard tab that pulls a widget drawer over the page: today, the month, the open workspace, thread meters, and the agent, with a cat at play (a Lottie animation; needs the Qt Lottie module, `qt6-lottie` on Arch, and shows the agent's initial without it). |
| `glass`     | The shape of a Mac app: one rounded window with a hairline edge, traffic lights, a translucent sidebar for the compositor to blur behind, and a unified toolbar over an opaque content column.                                                                                                                        |
| `terminal`  | Status line with prompt mark, counts, model, the palette's sixteen colours and a clock; mono type, sharp corners. `theme-from-terminal.mjs` writes a `theme.json` in the colours of the terminal you run it from.                                                                                                     |

Pick up the terminal's colours with:

```sh
node apps/desktop-qt/examples/terminal/theme-from-terminal.mjs ~/.t3/shell/theme.json
```

What you can reach from `shell.qml`: `ShellWindow` as the root (window
colour, opacity and frame from the theme, `sidebarCollapsed` and
`settingsActive` from the page, the error overlay and the page's window
commands built in), the bricks (`TitleBar`, `Sidebar`, `SettingsNav`,
`Workspace`, `GitActions`, `WebSurface`, `Composer`, `RightPanel`,
`Notifications`), the themed controls (`ShellCard`, `ShellButton`,
`ShellComboBox`, `ShellTextField`, `ShellMenu`, `ShellMenuItem`, `ShellIcon`,
`WindowControls`), and the `T3.Shell` singletons: `Shell.state.<key>` for
everything the page publishes, `Shell.dispatch(action, payload)` to act,
`Theme.color(role, fallback)` / `Theme.radius` / `Theme.fontUi` /
`Theme.fontMono`, and `Runtime.reload()`.

A broken `shell.qml` never locks you out: the built-in shell takes over with
the error shown in an overlay.
