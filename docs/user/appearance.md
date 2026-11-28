# Appearance and themes

Customize Hyakki's theme, light/dark appearance, math rendering, motion, and custom CSS. Appearance settings are saved per device or browser.

## Switch themes and appearance

- **Web and desktop**: Open **Settings → Appearance** to choose a theme and light, dark, or system mode. Select the light or dark preview on a theme card to pair different themes with each mode.
  - Open theme picker from anywhere: `Cmd+Option+A` (macOS) or `Ctrl+Alt+A` (Windows/Linux), or **Change theme** in the command palette.
  - Cycle System / Light / Dark: `Cmd+Option+Shift+A` (macOS) or `Ctrl+Alt+Shift+A` (Windows/Linux), or **Change appearance** in the command palette.
- **Mobile**: Open **Settings → Appearance**. Mobile uses its own themes and text/code/terminal preferences and does not follow environment themes.
  - On Android 12+, **Material You** pulls colors from your wallpaper (configurable separately for light and dark), and **Material You Layout** controls Material You shapes and spacing independently of the theme.

## Composer context

Git-backed projects show branch and worktree controls below the composer before the first message. Turn on **Settings → Appearance → Composer context** (web and desktop) to keep those controls visible after the thread starts.

## Math

Turn on **Settings → Appearance → Render math** (per device) to render LaTeX in messages and Markdown previews on web, desktop, and mobile.

- Supports `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, and fenced `math` blocks outside of code.
- Currency like `$5 and $10` stays plain text; use `\$` to escape other literal dollar signs.
- Copying a formula or exporting a table preserves the raw TeX. The composer keeps TeX source editable.

## Motion

Sidebars, the right panel, and the terminal drawer open immediately by default. Adjust **Settings → Appearance → Panel animations** (0–400 ms) to enable transitions, unless OS reduced motion is enabled.

## Custom themes

On web and desktop, choose **Create theme** in **Settings → Appearance** to edit a palette, import a Hyakki or VS Code theme, or export your theme as JSON.

### Custom CSS

Open **Custom CSS** in the theme editor for styling beyond palette colors. Custom CSS is saved with the theme and included in exports.

- Use `.dark` or `:root:not(.dark)` to target one appearance.
- Target `data-slot` and other `data-` attributes (such as `[data-chat-header]` or `[data-slot="button"]`) rather than class names, which change between releases.
- External resource loading (`@import`, `image-set()`, and non-`data:`/`#id` `url()`) is blocked for security. Use a [background image](#background-image) for full-size images.
- **Recovery**: If custom CSS hides something you need, run `hyakki theme set t3-chat` on the server or press `Cmd+Option+A` / `Ctrl+Alt+A` to switch themes.

### Ask an agent

An agent running on the same machine as the server in **Full access** mode can restyle Hyakki for you (for example, "give Hyakki a solarized theme"). It publishes an [environment theme](#environment-themes) and switches connected web and desktop clients to it. Ask the agent to switch back to a built-in theme to undo.

## Environment themes

Environment themes come from the server serving your web app or the desktop app's local environment (or local [background service](./background-service.md) when the built-in local environment is off). Hosted `hyakki.ryoku.dev` and remote connections do not apply them.

Select a published theme in **Settings → Appearance** to track server updates, or **Duplicate** it for an independent editable copy.

Manage the server default from the CLI:

```bash
t3 theme set nightfall   # Set default and switch connected/reconnecting clients once
t3 theme clear           # Remove the default without changing current client themes
t3 theme show            # List the default and all published themes
```

### Publish a theme

Save an exported theme JSON into `~/.hyakki/userdata/themes/` on the server (or `themes/` under your custom state directory). The filename sets the theme ID (e.g. `nightfall.json` → `hyakki theme set nightfall`). Avoid reserved IDs (`system`, `light`, `dark`, or built-in theme IDs).

You can also use a minimal palette format—Hyakki generates the remaining tokens:

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

Include an optional `css` string for [custom CSS](#custom-css). Write updates atomically (temp file + rename) so clients never read a partial file.

### Background image

Place a JPEG, PNG, or WebP file (up to 16 MB) next to a published theme file with the same base name (e.g. `nightfall.jpg` beside `nightfall.json`), or ask an agent to set one. Reference it in the theme's CSS:

```css
[data-workspace-area="conversation"] {
  background: var(--theme-background-image) center / cover no-repeat;
}
```

Delete the image file to remove it.
