# Conn Visual Design Specification (GPUI Target)

`conn-gpui` must look **pixel-for-pixel** like Conn desktop (the Conn monorepo). Do not accept generic GPUI or `gpui-kit` styling.

Primary sources of truth (always check these before guessing):
- `.claude/skills/nckrtl-shell-design/SKILL.md`
- `.claude/skills/nckrtl-shell-design/references/tokens.md`
- `FORK.md` ("Shell design", "Icons", "Workspaces")
- `apps/web/src/index.css` (shell tokens at the end of the file)
- `packages/shared/src/themePalettes.ts` (all 60+ semantic `THEME_COLOR_ROLES` and built-in themes)
- `apps/desktop/src/window/DesktopWindow.ts` (macOS traffic light positioning & vibrancy)

---

## 1. Window & Shell Geometry

| Metric | Value | Notes |
| --- | --- | --- |
| Window outer corner radius | `18px` | Native macOS window mask (`--window-radius`) |
| Shell inset | `4px` | Gap between inset cards and window outer edge (`--shell-inset`) |
| Inset card corner radius | `14px` | Concentric: `18px - 4px` (`--shell-corner`) |
| Header height | `44px` | Transparent over frosted frame (`--shell-header-height`) |
| macOS traffic lights center Y | `22px` | Centered on `44px` header, **not** macOS's default `52px` titlebar |
| Fixed right header controls inset | `11px` | `--workspace-controls-right`; aligns last header toggle over panel's last group button |
| Inner panel border | `0.5px` | `8%` black (light) / `8%` white (dark); no top highlight |
| Panel seam divider | `1px` | Replaces both adjacent `0.5px` inner borders; two-tone (switches color at `44px` header height) |
| Workspace rail tile corner | `radius - 5px` | `rounded-tile` inside rail button; active workspace has `2px` inset ring (`sidebar-foreground` @ 90%) with visible inner gap |
| User chat bubble corner | `16px` | `radius + 6px` (`--radius-bubble`) |
| Floating surface (`dropdown-glass`) corner | `12px` (`rounded-xl`) | Rows inside: `8px` (`rounded-lg`), dividers: `--glass-divider` (`fg` @ 8%) |
| Inset scrollbar | `16px` lane, `6px` thumb | Fully pill-rounded thumb, `5px` inset from card edges |

### Frosted macOS Surfaces
- **Outer frame (`--shell-fill`):** macOS native vibrancy material tinted with `--shell-fill` (`60%` opacity on macOS; `sidebar 92% + fg` in dark mode).
- **Inner cards (`shell-inner-panel`):** Chat card, right-panel card, and Settings content card paint a `76%` tint of `--shell-card` (`= --sidebar`) over the frosted outer frame. Reduce Transparency falls back to opaque `--shell-card`.
- Nested controls, editors, and toolbar sheets stay opaque (`--shell-card` / `--shell-control`).
- Chat, right panel, and Settings re-root `--background`, `--terminal-background`, and (right panel) `--code-background` to `--shell-card` so file viewer, diffs, explorer, terminal, and chat share one continuous surface. Chat fenced code blocks keep their own `--code-background`.

---

## 2. Color Derivation Rules (`conn-theme`)

Every shell surface and divider is computed in sRGB via `color-mix(in srgb, A p%, B)` from the active theme's roles (`--sidebar`, `--background`, `--foreground`, `--popover`, `--muted`, `--muted-foreground`, `--primary`).

**Dark mode reference formulas** (read `apps/web/src/index.css` tail for exact light mode formulas too):

| Token | Dark formula | Usage |
| --- | --- | --- |
| `--shell-fill` | `mix(sidebar 92%, fg)` @ 60% alpha (macOS) | Frosted window frame & glass headers |
| `--shell-panel` / `--shell-card` | `sidebar` (76% alpha on macOS inner panel) | Thread sidebar, chat card, right panel, Settings card |
| `--shell-raised` | `mix(background 86%, fg)` | Raised controls |
| `--shell-overlay` | `mix(popover 96%, fg)` @ 94% alpha | `dropdown-glass` menus, popovers, tooltips, toasts |
| `--shell-highlight` | `fg` @ 8% alpha (light: 6%) | Hover/selected pills, settings groups, raised `Kbd` |
| `--shell-tile` | `mix(sidebar 80%, fg)` | Empty-state icon tiles |
| `--shell-tile-border` | `mix(sidebar 92%, fg)` | Empty-state icon tile border |
| `--shell-field` | `mix(sidebar 92%, fg)` | Soft search & browser address fields |
| `--shell-control` | `mix(sidebar 91%, fg)` | `ToolbarGroup` fill, soft field hover |
| `--shell-divider` | `mix(sidebar 89%, fg)` | Dividers inside cards, panel splits, list rows |
| `--shell-divider-header` | `mix(sidebar 82%, fg)` | Header-height dividers, soft field & `ToolbarGroup` borders |
| `--shell-divider-raised` | `mix(sidebar 78%, fg)` | Row dividers inside raised settings groups |
| `--glass-divider` | `fg` @ 8% alpha | Edge & section dividers inside `dropdown-glass` |
| `--muted-foreground-raised` | `mix(muted-fg 80%, fg)` | Secondary text inside raised settings groups |
| `--switch-on` | `mix(primary 70%, fg)` | Checked switch track |
| `--sidebar-row-hover/selected/active` | `white` @ 4% / 6% / 8% (light: `black` @ 3% / 5% / 7%) | Sidebar & workspace rail row fills (lighting overlays, never opaque) |

**Primary verification themes:**
1. **Dark Ocean** (Nick's primary dark theme — check `~/.t3/dev/themes/dark-ocean.json` if present on the machine, or `ocean` / `t3-code` dark as bundled fallback).
2. **T3 Code Light** (`T3_CODE_LIGHT_THEME_COLORS` in `packages/shared/src/themePalettes.ts`).

---

## 3. Typography & Icons

- **UI size (`text-ui`):** `13px` / `20px` line height across panel chrome, titles, descriptions, status lines, controls, tree items, settings rows, and notices. Never shrink secondary panel text to 11px/12px.
- **Tab labels & breadcrumbs:** `14px` (`text-sm`); tab & header icons `16px` (`size-4`).
- **Fonts:** System/Inter sans everywhere except code & terminal output (JetBrains Mono / monospace). Versions, timestamps, and metadata stay sans with `tabular-nums`.
- **Headings:** Normal sentence case, foreground color. **No uppercase section headers.**
- **Icons:**
  - **Everywhere (chrome, sidebar, headers, panels, settings, timeline, work log):** superheroicons 16/solid (`~/apps/superheroicons/consumers/conn/final/16/solid`). The library's `manifest.json` maps each Lucide name Conn used to its concept; `crates/conn-app/src/superhero.rs` applies it. This replaces the earlier Lucide (chrome) + Phosphor (timeline) split.

---

## 4. Controls & Shared Components

- **`ToolbarGroup`:** Height `32px` (`h-8`), pill radius (`9999px` — controlled by one `--toolbar-radius` token), `3px` inner padding holding `24px` ghost icon/label buttons, `--shell-control` fill, `--shell-divider-header` border, `8px` gap between adjacent groups. Pressed toggles keep no fill and brighten their icon to `foreground` (never blue).
- **Soft fields (Files search, Browser address bar):** Height `32px` (`h-8`), `--toolbar-radius`, `--shell-field` fill, `--shell-divider-header` border, leading search/globe icon, `13px` text.
- **Chat header action buttons:** `28px` circular buttons (`9999px`) inside the `44px` header; rest fill `--shell-header-control`, hover `--shell-header-control-hover`.
- **Switches:** Pill track (`9999px`), checked color `--switch-on`, concentric thumb.
- **Key caps (`Kbd`):** Raised style using `--shell-highlight` fill and light text.
- **Notices:** `4px`-inset rounded container, `bg-warning/10` + `text-warning` for warnings, `bg-info/10` + `text-info-foreground` for info; icon and text vertically centered on one line.
- **Panel splits (Files, Diff):** One continuous horizontal divider under the toolbar across both columns + one vertical divider meeting in a clean **T** (never double borders).
- **Settings route modal (`AppRouteModal`):** Frosted frame, `44px` transparent header, inset left nav matching thread-row hover fills, inset content card with square rows (`rounded-none`) divided by `--shell-divider-raised` (no trailing bottom divider), trailing switches/pickers aligned with the row title line.

---

## 5. Layout Skeleton (Default Desktop Window)

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  [Workspace] [Sidebar Header] │ [Thread Title / Branch]  [Panel Btns]│  <- 44px transparent glass header
├─[Rail]─┬──[Thread Sidebar]──────────┼──[Chat Card]────────┬──[Right Panel]─┤
│  [W1]  │  + New thread              │                     │ [Files|Diff|   │
│  [W2]  │  Projects / Threads        │  Messages timeline  │  Term|Browser] │
│  [W3]  │   • project-a              │  (superheroicons,   ├────────────────┤
│        │     - Active thread        │   Markdown, tools,  │ ToolbarGroup   │
│        │     - Completed thread     │   status rows)      ├────────┬───────┤
│        │   • project-b              │                     │ Tree / │ View /│
│        │                            │ ┌─────────────────┐ │ List   │ Code /│
│   [+]  │                            │ │ Composer +      │ │        │ Term /│
│  [⚙]   │                            │ │ Model/BranchBar │ │        │ CEF   │
└────────┴────────────────────────────┴─┴─────────────────┴─┴────────┴───────┘
  ^ 4px outer shell inset around cards, 14px concentric card corners, 0.5px inner border
```
