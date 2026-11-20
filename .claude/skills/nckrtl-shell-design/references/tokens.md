# Shell tokens

All shell tokens live at the end of `apps/web/src/index.css` (`:root` and
`:root.dark`). Scale tokens live in the `@theme inline` block. Every color is a
mix of the active theme's own roles (`--sidebar`, `--background`,
`--foreground`, `--popover`, `--muted`, `--primary`). The inner-shell black/white separator models physical lighting from
DesignKit; other surfaces keep their theme roles.

Values below are the dark values unless noted. Read `index.css` for the light
values before you change a token.

## Window and layout

| Token                              | Value                                | Use                                                                                              |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `--window-radius`                  | 18px                                 | DesignKit window geometry; macOS owns its native window mask.                                    |
| `--shell-inset`                    | 4px                                  | Gap between an inset card and the window edge.                                                   |
| `--shell-corner`                   | `window-radius - shell-inset` (14px) | Outer top and bottom corners of inset cards, so they stay concentric with the window.            |
| `--shell-header-height`            | 44px                                 | Glass header over chat, right panel and Settings. Two-tone dividers switch color at this height. |
| `--shell-blur`, `--shell-saturate` | 40px, 1.6                            | Backdrop blur for the frame and floating surfaces.                                               |

## Surfaces

| Token                 | Dark value                                    | Goes on                                                                                                                        |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--shell-fill`        | sidebar 92% + fg, at 86% opacity (macOS: 60%) | The frosted window frame and glass headers.                                                                                    |
| `--shell-panel`       | `--sidebar`                                   | The inset thread panel.                                                                                                        |
| `--shell-card`        | `= --shell-panel`                             | Chat card, right-panel card, Settings content card. These cards re-root `--background` and `--terminal-background` on it.      |
| `--shell-raised`      | background 86% + fg                           | Raised controls.                                                                                                               |
| `--shell-overlay`     | popover 96% + fg, at 94% opacity              | Menus, selects, comboboxes, popovers, tooltips, toasts, annotation panels (via `dropdown-glass`).                              |
| `--shell-highlight`   | fg at 8% (light: 6%)                          | Hover and active pills: menu rows, panel tabs, file tree hover, selected provider row, settings group fill, `Kbd` raised caps. |
| `--shell-tile`        | sidebar 80% + fg                              | Empty-state icon tiles. Lighter than the card.                                                                                 |
| `--shell-tile-border` | sidebar 92% + fg                              | Tile border: the raised card's color made opaque.                                                                              |
| `--shell-field`       | sidebar 92% + fg                              | Soft input fields (Files search, browser address).                                                                             |
| `--shell-control`     | sidebar 91% + fg                              | `ToolbarGroup` fill, soft field hover. Slightly darker than the field.                                                         |

## Dividers and text

| Token                       | Dark value               | Use                                                                                                       |
| --------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `--shell-divider`           | sidebar 89% + fg, opaque | Lines in cards: panel splits, toolbar bottoms, list row dividers.                                         |
| `--shell-divider-header`    | sidebar 82% + fg         | Lines on the lighter frame (header stretch), soft field and `ToolbarGroup` borders, settings card border. |
| `--shell-divider-raised`    | sidebar 78% + fg         | Row dividers inside a raised card (settings groups, keybinding rows).                                     |
| `--glass-divider`           | fg at 8%                 | Section dividers inside a `dropdown-glass` surface; also its edge.                                        |
| `--muted-foreground-raised` | muted-fg 80% + fg        | Settings groups re-root `--muted-foreground` to this on their raised fill.                                |

## Controls

| Token                   | Value                           | Use                                                                                                                              |
| ----------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--switch-on`           | primary 70% + fg                | Checked track of every switch (`ui/switch.tsx`, menu switch item).                                                               |
| `--switch-radius`       | 9999px                          | Switch track. Keep the pill. 6px gives the rejected rounded square.                                                              |
| `--switch-thumb-radius` | `max(switch-radius - 2px, 1px)` | Knob, concentric with the track.                                                                                                 |
| `--control-radius`      | set per container               | Button and toggle corners. Chat and Settings headers: 9999px. Right panel card: 6px. `ToolbarGroup`: `--toolbar-control-radius`. |

## Toolbar controls

| Token                           | Value (dark)                           | Use                                                                                                    |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `--toolbar-radius`              | `9999px` (alt `var(--radius)`)         | `ToolbarGroup` and soft field corners. The pill vs rounded-rectangle switch.                           |
| `--toolbar-control-radius`      | `9999px` (alt `6px`)                   | Buttons inside a `ToolbarGroup`. Change together with `--toolbar-radius`.                              |
| `--toolbar-group-fill`          | `var(--shell-control)`                 | What `ToolbarGroup` paints. Re-root on a surface to raise its groups.                                  |
| `--toolbar-group-border`        | `var(--shell-divider-header)`          | `ToolbarGroup` border. Re-root together with the fill.                                                 |
| `--shell-control-raised`        | sidebar 86% + foreground               | Group fill on a surface that itself uses `--shell-control` (toolbar sheet).                            |
| `--shell-control-raised-border` | sidebar 74% + foreground               | Group border on that surface.                                                                          |
| `--shell-header-control`        | dark: toolbar control 50% + hover role | Rest fill of chat header buttons (`[data-chat-header]` rule). Light: the theme's toolbar control role. |
| `--shell-header-control-hover`  | dark: hover role 94% + foreground      | Hover and pressed fill of those buttons, one step past rest. Light: the theme's hover role.            |
| `--workspace-controls-right`    | safe area + 11px                       | Inset of the fixed header controls; aligns the last toggle with the panel's last group button.         |
| `--glass-divider`               | foreground 8%, transparent             | Set by `dropdown-glass`: its edge, menu separators and section dividers inside glass.                  |
| `TOOLBAR_SHEET_INSET`           | 6px (`panelResize.ts`)                 | Laravel toolbar sheet inset from the panel sides, the bar and the page top.                            |

## Scale additions (`@theme inline`)

| Token                   | Value                  | Utility                                                                   |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------- |
| `--text-ui`             | 13px, 20px line height | `text-ui`. Registered in tailwind-merge in `lib/utils.ts`.                |
| `--radius-tile`         | `radius - 5px`         | `rounded-tile`: workspace tile inside a rail button.                      |
| `--radius-bubble`       | `radius + 6px` (16px)  | `rounded-bubble`: the user's chat bubble.                                 |
| `--spacing-toolbar`     | 7.5px                  | `py-toolbar`, `pt-toolbar`: panel toolbar rows.                           |
| `--spacing-toolbar-end` | 11.5px                 | `pe-toolbar-end`: end gap so a 24px button's side gap equals its top gap. |

## Utilities and classes

- `dropdown-glass`: floating surfaces. Sets `--accent: var(--shell-highlight)`.
- `shell-divider-r`, `shell-divider-l`: full-height two-tone dividers via
  `border-image`, lighter through the header. Border images beat the global
  border color, so no `!` is needed.
- `.scrollbar-inset`: plain unlayered CSS. 16px lane, 6px thumb with a 5px
  transparent border, `border-radius: 9999px`, track `margin-block: 0`. Pair it
  with `scrollbar-gutter-both`. Used by `SettingsPageContainer`, the chat
  timeline, the file preview and the read-only source preview. Pierre trees get
  the same rules through `PIERRE_TREE_UNSAFE_CSS`.
- `.mock-window-shadow`, `.mock-traffic-light-*`: web-only mock window in
  `routes/__root.tsx`. Fixed system colors on purpose.

## Inner shell (DesignKit geometry)

- `--window-radius` 18px, `--shell-inset` 4px, `--shell-corner` 14px.
- `shell-inner-panel` paints `--shell-inner-fill`; semantic `--shell-card` stays opaque.
- macOS inner fill: card at 76% over the frame's 60% tint; the shared native material and 40px outer CSS blur (no extra per-panel blur).
  These strengths adapt native system frosting; DesignKit has no fixed blur radius.
- `--shell-inner-border`: 8% black (light) / white (dark), 0.5px inset.
- Conn's web shell has no top highlight (Nick, 2026-10-15). The full-height
  1px panel divider replaces the adjacent inner-panel edges at each seam.
