---
title: "Appearance and themes"
description: "Set T3 Code themes and light or dark mode, create custom palettes, publish environment themes, and control math, motion, and thread details."
updated: 2026-11-04
sources:
  - label: "Appearance and themes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/appearance.md"
  - label: "Usage and thread details"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
  - label: "Settings scope"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md"
faq:
  - question: "How do I change the T3 Code theme?"
    answer: "On web and desktop, open Settings → Appearance in T3 Code, or use Change theme in the command palette. Choose light and dark previews separately if you want different themes for each mode."
  - question: "Does T3 Code follow my system dark mode?"
    answer: "T3 Code lets you choose System, Light, or Dark independently of the theme. Appearance preferences are saved separately on each device or browser."
  - question: "Can I import a VS Code theme into T3 Code?"
    answer: "T3 Code supports importing T3 Code and VS Code themes on web and desktop. You can edit the palette and export your custom theme as JSON."
  - question: "Why does my phone have a different T3 Code theme?"
    answer: "T3 Code mobile has its own appearance preferences and themes. It does not follow environment themes or defaults."
---

T3 Code lets you choose a theme and use System, Light, or Dark appearance in `Settings → Appearance`. On web and desktop, you can choose different themes for light and dark mode, create palettes, and import themes. Preferences are saved separately on each device or browser.

## Change the theme without leaving your thread

On web and desktop, open **Change theme** in the command palette. Choose the corresponding light or dark preview when you want a theme assigned to that appearance. The palette also has **Change appearance**, which changes the mode independently of the palette.

| Task                          | macOS default        | Windows and Linux default |
| ----------------------------- | -------------------- | ------------------------- |
| Open the theme picker         | `Cmd+Option+A`       | `Ctrl+Alt+A`              |
| Cycle System, Light, and Dark | `Cmd+Option+Shift+A` | `Ctrl+Alt+Shift+A`        |

These shortcuts can be changed in `Settings → Keybindings`. Read [keybindings](/learn/customize/keybindings) to resolve a conflict with another app or desktop shortcut. If moving between the composer and Settings is the difficult part, use [workspace focus navigation](/learn/customize/keyboard-focus).

Choose **System** when you want appearance to follow the operating system. Choose **Light** or **Dark** when you want that mode to remain selected. Pick the palette separately, so changing mode does not require rebuilding a custom theme.

## Create, import, and share a custom palette

On web and desktop:

1. Open `Settings → Appearance`.
2. Choose **Create theme**, or import a T3 Code or VS Code theme.
3. Use the editor's color picker to select an area of the app and find its color.
4. Adjust the palette, then export it as JSON when you want to share it.

The area picker helps when you can identify an element visually but do not know its color name. For a server-published theme, choose **Duplicate** before editing when you want an independent copy. Following a published theme keeps its palette connected to the server's updates.

A saved custom theme with the same ID takes priority over a published theme. If a published update seems absent, check for that local copy. If the server stops publishing the selected theme, T3 Code uses its standard theme as a fallback.

## Publish an environment theme for connected clients

Environment themes come from the server serving your web app or the desktop app's main local environment. Additional connections and `app.t3.codes` do not use those themes or defaults. This scope differs from [project and environment settings](/learn/customize/project-settings).

To publish a palette:

1. Export a theme from T3 Code.
2. Save it in `~/.t3/userdata/themes/` on the server, or the `themes` directory under your custom state directory.
3. Use a stable filename such as `nightfall.json`.
4. Run the following command on the server.

```bash
t3 theme set nightfall
```

The filename provides the ID. Avoid `system`, `light`, `dark`, and built-in theme IDs. For generated themes, T3 Code also accepts a compact format:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark`. Supply hex colors for `canvas` and `accent`; T3 Code generates the remaining palette. Optional `colors` overrides use names from the theme editor's advanced view.

Write updates to a temporary file, then rename it into place. This prevents clients from reading an incomplete theme. Invalid files are not published.

## Reapply or remove an environment default

`t3 theme set nightfall` switches connected clients to that default. Offline clients apply it when they reconnect. Each client applies the setting once. A later personal theme choice remains until another `t3 theme set` command.

Run the command again to reapply a default, even when its name stays the same. Use `t3 theme show` to inspect the default and published themes. Use `t3 theme clear` to remove the default while keeping clients' current selections.

Repository icons use a separate configuration. Set `iconPath` in [t3.json](/learn/customize/t3-project-file) when you want to share a project image through the repository.

## Adjust math, panel motion, and thread context

Enable **Render math** to typeset LaTeX in messages and Markdown previews. It supports inline and display delimiters outside code, plus fenced `math` blocks. The composer retains editable TeX source. The preference is separate on each device.

Panels open and close immediately by default. Increase **Panel animations** above zero to add motion, up to 400 milliseconds. The operating system's reduced-motion preference takes priority. Switching threads uses the selected thread's panel state without replaying transitions.

Enable **Composer context** on web or desktop to keep branch and worktree controls visible after a thread starts. For quota visibility, enable **Usage limits** under `Settings → Appearance → Thread details`. Enable **Context window** there to show the thread's context use. See [usage and limits](/learn/customize/usage-and-limits) for what those readings mean.

## Choose mobile appearance separately

Mobile has its own themes and text, code, and terminal preferences in `Settings → Appearance`. Android 12 and newer offer **Material You**, which uses wallpaper colors. You can assign it separately to light and dark appearances.

**Material You Layout** changes shapes, spacing, and controls independently of the palette. Android enables that layout by default unless you turn it off in Appearance. Choosing another theme changes the colors without requiring a different layout preference.

## Next steps

[Customize appearance shortcuts](/learn/customize/keybindings) and [move between workspace areas](/learn/customize/keyboard-focus).
Use the [settings and customization guide](/learn/customize) to choose where a preference belongs.
Continue with [visual replies and HTML renders](/learn/workspace/visual-replies) when the content you want to inspect is an agent's rendered output.
