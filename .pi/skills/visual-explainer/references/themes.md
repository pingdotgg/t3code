# Themes

Eleven prebuilt palettes and an optional runtime theme picker, for pages where the reader should be able to change the palette after the page is generated.

Use this reference when the user asks for switchable themes, names a theme directly (Dracula, Nord, Gruvbox, Catppuccin…), or wants a page that stays readable across very different lighting. For every other page, keep using the palette guidance in `css-patterns.md` — a picker is opt-in, not a default.

A theme here is one fixed palette, not a light/dark pair. Light and dark coverage comes from the theme list (7 dark, 4 light), and the picker is the reader's light/dark control. Do not wrap theme values in `@media (prefers-color-scheme: …)`; an explicit choice should not be overridden by the OS.

## Palettes

Each theme defines the same 21 custom properties `css-patterns.md` already uses, so every existing pattern works against a theme unchanged.

```js
const THEMES = {
  dracula: {
    label: "Dracula",
    mode: "dark",
    css: {
      "--bg": "#282a36",
      "--surface": "#44475a",
      "--surface-elevated": "#4d5066",
      "--border": "rgba(255,255,255,.08)",
      "--border-bright": "rgba(255,255,255,.15)",
      "--text": "#f8f8f2",
      "--text-dim": "#6272a4",
      "--accent": "#bd93f9",
      "--accent-dim": "rgba(189,147,249,.12)",
      "--node-a": "#8be9fd",
      "--node-a-dim": "rgba(139,233,253,.12)",
      "--node-b": "#50fa7b",
      "--node-b-dim": "rgba(80,250,123,.12)",
      "--node-c": "#ff79c6",
      "--node-c-dim": "rgba(255,121,198,.12)",
      "--green": "#50fa7b",
      "--green-dim": "rgba(80,250,123,.12)",
      "--red": "#ff5555",
      "--red-dim": "rgba(255,85,85,.12)",
      "--orange": "#ffb86c",
      "--orange-dim": "rgba(255,184,108,.12)",
    },
  },
  nord: {
    label: "Nord",
    mode: "dark",
    css: {
      "--bg": "#2e3440",
      "--surface": "#3b4252",
      "--surface-elevated": "#434c5e",
      "--border": "rgba(255,255,255,.06)",
      "--border-bright": "rgba(255,255,255,.12)",
      "--text": "#eceff4",
      "--text-dim": "#4c566a",
      "--accent": "#88c0d0",
      "--accent-dim": "rgba(136,192,208,.12)",
      "--node-a": "#88c0d0",
      "--node-a-dim": "rgba(136,192,208,.12)",
      "--node-b": "#a3be8c",
      "--node-b-dim": "rgba(163,190,140,.12)",
      "--node-c": "#b48ead",
      "--node-c-dim": "rgba(180,142,173,.12)",
      "--green": "#a3be8c",
      "--green-dim": "rgba(163,190,140,.12)",
      "--red": "#bf616a",
      "--red-dim": "rgba(191,97,106,.12)",
      "--orange": "#d08770",
      "--orange-dim": "rgba(208,135,112,.12)",
    },
  },
  "one-dark": {
    label: "One Dark",
    mode: "dark",
    css: {
      "--bg": "#282c34",
      "--surface": "#2c313a",
      "--surface-elevated": "#333842",
      "--border": "rgba(255,255,255,.06)",
      "--border-bright": "rgba(255,255,255,.12)",
      "--text": "#abb2bf",
      "--text-dim": "#5c6370",
      "--accent": "#61afef",
      "--accent-dim": "rgba(97,175,239,.12)",
      "--node-a": "#61afef",
      "--node-a-dim": "rgba(97,175,239,.12)",
      "--node-b": "#98c379",
      "--node-b-dim": "rgba(152,195,121,.12)",
      "--node-c": "#c678dd",
      "--node-c-dim": "rgba(198,120,221,.12)",
      "--green": "#98c379",
      "--green-dim": "rgba(152,195,121,.12)",
      "--red": "#e06c75",
      "--red-dim": "rgba(224,108,117,.12)",
      "--orange": "#e5c07b",
      "--orange-dim": "rgba(229,192,123,.12)",
    },
  },
  "catppuccin-mocha": {
    label: "Catppuccin Mocha",
    mode: "dark",
    css: {
      "--bg": "#1e1e2e",
      "--surface": "#313244",
      "--surface-elevated": "#45475a",
      "--border": "rgba(255,255,255,.06)",
      "--border-bright": "rgba(255,255,255,.12)",
      "--text": "#cdd6f4",
      "--text-dim": "#6c7086",
      "--accent": "#cba6f7",
      "--accent-dim": "rgba(203,166,247,.12)",
      "--node-a": "#89b4fa",
      "--node-a-dim": "rgba(137,180,250,.12)",
      "--node-b": "#a6e3a1",
      "--node-b-dim": "rgba(166,227,161,.12)",
      "--node-c": "#f5c2e7",
      "--node-c-dim": "rgba(245,194,231,.12)",
      "--green": "#a6e3a1",
      "--green-dim": "rgba(166,227,161,.12)",
      "--red": "#f38ba8",
      "--red-dim": "rgba(243,139,168,.12)",
      "--orange": "#fab387",
      "--orange-dim": "rgba(250,179,135,.12)",
    },
  },
  "tokyo-night": {
    label: "Tokyo Night",
    mode: "dark",
    css: {
      "--bg": "#1a1b26",
      "--surface": "#24283b",
      "--surface-elevated": "#292e42",
      "--border": "rgba(255,255,255,.06)",
      "--border-bright": "rgba(255,255,255,.12)",
      "--text": "#a9b1d6",
      "--text-dim": "#565f89",
      "--accent": "#7aa2f7",
      "--accent-dim": "rgba(122,162,247,.12)",
      "--node-a": "#7aa2f7",
      "--node-a-dim": "rgba(122,162,247,.12)",
      "--node-b": "#9ece6a",
      "--node-b-dim": "rgba(158,206,106,.12)",
      "--node-c": "#bb9af7",
      "--node-c-dim": "rgba(187,154,247,.12)",
      "--green": "#9ece6a",
      "--green-dim": "rgba(158,206,106,.12)",
      "--red": "#f7768e",
      "--red-dim": "rgba(247,118,142,.12)",
      "--orange": "#ff9e64",
      "--orange-dim": "rgba(255,158,100,.12)",
    },
  },
  "gruvbox-dark": {
    label: "Gruvbox Dark",
    mode: "dark",
    css: {
      "--bg": "#282828",
      "--surface": "#3c3836",
      "--surface-elevated": "#504945",
      "--border": "rgba(255,255,255,.06)",
      "--border-bright": "rgba(255,255,255,.12)",
      "--text": "#ebdbb2",
      "--text-dim": "#a89984",
      "--accent": "#fe8019",
      "--accent-dim": "rgba(254,128,25,.12)",
      "--node-a": "#83a598",
      "--node-a-dim": "rgba(131,165,152,.12)",
      "--node-b": "#b8bb26",
      "--node-b-dim": "rgba(184,187,38,.12)",
      "--node-c": "#d3869b",
      "--node-c-dim": "rgba(211,134,155,.12)",
      "--green": "#b8bb26",
      "--green-dim": "rgba(184,187,38,.12)",
      "--red": "#fb4934",
      "--red-dim": "rgba(251,73,52,.12)",
      "--orange": "#fe8019",
      "--orange-dim": "rgba(254,128,25,.12)",
    },
  },
  "synthwave-84": {
    label: "Synthwave '84",
    mode: "dark",
    css: {
      "--bg": "#262335",
      "--surface": "#241b2f",
      "--surface-elevated": "#2e2543",
      "--border": "rgba(255,255,255,.08)",
      "--border-bright": "rgba(255,255,255,.15)",
      "--text": "#ffffff",
      "--text-dim": "#848bbd",
      "--accent": "#ff7edb",
      "--accent-dim": "rgba(255,126,219,.12)",
      "--node-a": "#36f9f6",
      "--node-a-dim": "rgba(54,249,246,.12)",
      "--node-b": "#72f1b8",
      "--node-b-dim": "rgba(114,241,184,.12)",
      "--node-c": "#fede5d",
      "--node-c-dim": "rgba(254,222,93,.12)",
      "--green": "#72f1b8",
      "--green-dim": "rgba(114,241,184,.12)",
      "--red": "#fe4450",
      "--red-dim": "rgba(254,68,80,.12)",
      "--orange": "#ff8b39",
      "--orange-dim": "rgba(255,139,57,.12)",
    },
  },
  "solarized-light": {
    label: "Solarized Light",
    mode: "light",
    css: {
      "--bg": "#fdf6e3",
      "--surface": "#eee8d5",
      "--surface-elevated": "#ffffff",
      "--border": "rgba(0,0,0,.08)",
      "--border-bright": "rgba(0,0,0,.15)",
      "--text": "#526970",
      "--text-dim": "#526970",
      "--accent": "#00629b",
      "--accent-dim": "rgba(0,98,155,.10)",
      "--node-a": "#00629b",
      "--node-a-dim": "rgba(0,98,155,.10)",
      "--node-b": "#859900",
      "--node-b-dim": "rgba(133,153,0,.10)",
      "--node-c": "#d33682",
      "--node-c-dim": "rgba(211,54,130,.10)",
      "--green": "#859900",
      "--green-dim": "rgba(133,153,0,.10)",
      "--red": "#dc322f",
      "--red-dim": "rgba(220,50,47,.10)",
      "--orange": "#cb4b16",
      "--orange-dim": "rgba(203,75,22,.10)",
    },
  },
  "github-light": {
    label: "GitHub Light",
    mode: "light",
    css: {
      "--bg": "#ffffff",
      "--surface": "#f6f8fa",
      "--surface-elevated": "#ffffff",
      "--border": "rgba(0,0,0,.08)",
      "--border-bright": "#d0d7de",
      "--text": "#1f2328",
      "--text-dim": "#656d76",
      "--accent": "#0969da",
      "--accent-dim": "rgba(9,105,218,.10)",
      "--node-a": "#0969da",
      "--node-a-dim": "rgba(9,105,218,.10)",
      "--node-b": "#1a7f37",
      "--node-b-dim": "rgba(26,127,55,.10)",
      "--node-c": "#8250df",
      "--node-c-dim": "rgba(130,80,223,.10)",
      "--green": "#1a7f37",
      "--green-dim": "rgba(26,127,55,.10)",
      "--red": "#cf222e",
      "--red-dim": "rgba(207,34,46,.10)",
      "--orange": "#bc4c00",
      "--orange-dim": "rgba(188,76,0,.10)",
    },
  },
  "catppuccin-latte": {
    label: "Catppuccin Latte",
    mode: "light",
    css: {
      "--bg": "#eff1f5",
      "--surface": "#ccd0da",
      "--surface-elevated": "#ffffff",
      "--border": "rgba(0,0,0,.08)",
      "--border-bright": "rgba(0,0,0,.15)",
      "--text": "#4c4f69",
      "--text-dim": "#9ca0b0",
      "--accent": "#8839ef",
      "--accent-dim": "rgba(136,57,239,.10)",
      "--node-a": "#1e66f5",
      "--node-a-dim": "rgba(30,102,245,.10)",
      "--node-b": "#40a02b",
      "--node-b-dim": "rgba(64,160,43,.10)",
      "--node-c": "#ea76cb",
      "--node-c-dim": "rgba(234,118,203,.10)",
      "--green": "#40a02b",
      "--green-dim": "rgba(64,160,43,.10)",
      "--red": "#d20f39",
      "--red-dim": "rgba(210,15,57,.10)",
      "--orange": "#fe640b",
      "--orange-dim": "rgba(254,100,11,.10)",
    },
  },
  "gruvbox-light": {
    label: "Gruvbox Light",
    mode: "light",
    css: {
      "--bg": "#fbf1c7",
      "--surface": "#ebdbb2",
      "--surface-elevated": "#ffffff",
      "--border": "rgba(0,0,0,.08)",
      "--border-bright": "rgba(0,0,0,.15)",
      "--text": "#3c3836",
      "--text-dim": "#7c6f64",
      "--accent": "#af3a03",
      "--accent-dim": "rgba(175,58,3,.10)",
      "--node-a": "#076678",
      "--node-a-dim": "rgba(7,102,120,.10)",
      "--node-b": "#79740e",
      "--node-b-dim": "rgba(121,116,14,.10)",
      "--node-c": "#8f3f71",
      "--node-c-dim": "rgba(143,63,113,.10)",
      "--green": "#79740e",
      "--green-dim": "rgba(121,116,14,.10)",
      "--red": "#9d0006",
      "--red-dim": "rgba(157,0,6,.10)",
      "--orange": "#af3a03",
      "--orange-dim": "rgba(175,58,3,.10)",
    },
  },
};
```

## Mermaid variables derive from the palette

Do not store `themeVariables` per theme. All 18 derive from 6 palette values, which is what keeps a diagram in sync with the page around it:

```js
function mermaidVars(css) {
  const bg = css["--bg"],
    surface = css["--surface"];
  const text = css["--text"],
    dim = css["--text-dim"],
    accent = css["--accent"];
  return {
    primaryColor: surface,
    primaryTextColor: text,
    primaryBorderColor: dim,
    secondaryColor: accent,
    secondaryTextColor: bg,
    secondaryBorderColor: accent,
    tertiaryColor: bg,
    tertiaryTextColor: text,
    tertiaryBorderColor: dim,
    mainBkg: surface,
    nodeBorder: dim,
    nodeTextColor: text,
    clusterBkg: bg,
    clusterBorder: dim,
    edgeLabelBackground: bg,
    lineColor: dim,
    textColor: text,
    titleColor: text,
  };
}
```

## Font pairs

The picker offers the pairs already recommended in `SKILL.md`, so a switchable page cannot wander outside the curated set:

```js
const FONT_PAIRS = {
  dm: { label: "DM Sans", sans: "'DM Sans'", mono: "'Fira Code'" },
  instrument: { label: "Instrument Serif", sans: "'Instrument Serif'", mono: "'JetBrains Mono'" },
  plex: { label: "IBM Plex Sans", sans: "'IBM Plex Sans'", mono: "'IBM Plex Mono'" },
  bricolage: {
    label: "Bricolage Grotesque",
    sans: "'Bricolage Grotesque'",
    mono: "'JetBrains Mono'",
  },
  jakarta: { label: "Plus Jakarta Sans", sans: "'Plus Jakarta Sans'", mono: "'Azeret Mono'" },
};
```

Swapping fonts only works if the page reads them through variables, so use `var(--font-body)` and `var(--font-mono)` everywhere rather than naming families in rules. Load every family in one stylesheet link, at every weight the page uses:

```
https://fonts.googleapis.com/css2?family=Azeret+Mono:wght@400;500&family=Bricolage+Grotesque:wght@400;600;700&family=DM+Sans:wght@400;500;700&family=Fira+Code:wght@400;500&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Instrument+Serif&family=JetBrains+Mono:wght@400;500&family=Plus+Jakarta+Sans:wght@400;600;700&display=swap
```

## Picker markup

One bar holding both groups. Every control is built from the data, so a dot's color or a chip's typeface cannot drift from what it selects:

```html
<div class="picker-bar">
  <div class="theme-picker" role="group" aria-label="Color theme"></div>
  <div class="font-picker" role="group" aria-label="Font pair"></div>
</div>
```

```js
const themePicker = document.querySelector(".theme-picker");
for (const [id, theme] of Object.entries(THEMES)) {
  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = "theme-dot";
  dot.dataset.theme = id;
  dot.title = theme.label;
  dot.setAttribute("aria-label", theme.label);
  dot.setAttribute("aria-pressed", String(id === DEFAULT_THEME));
  dot.style.background = theme.css["--surface"];
  dot.style.borderColor = theme.css["--accent"];
  dot.addEventListener("click", () => applyTheme(id));
  themePicker.append(dot);
}

const fontPicker = document.querySelector(".font-picker");
for (const [id, pair] of Object.entries(FONT_PAIRS)) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "font-chip";
  chip.dataset.font = id;
  chip.textContent = "Aa";
  chip.title = pair.label;
  chip.setAttribute("aria-label", pair.label);
  chip.setAttribute("aria-pressed", String(id === DEFAULT_FONT));
  chip.style.fontFamily = `${pair.sans}, system-ui, sans-serif`;
  chip.addEventListener("click", () => applyFont(id));
  fontPicker.append(chip);
}
```

## Picker CSS

```css
.picker-bar {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--border-bright);
}
.theme-picker,
.font-picker {
  display: flex;
  align-items: center;
  gap: 6px;
}
.font-picker {
  padding-left: 10px;
  border-left: 1px solid var(--border-bright);
}

.theme-dot {
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  border: 2px solid;
  cursor: pointer;
  transition: transform 0.12s ease;
}
.theme-dot:hover {
  transform: scale(1.15);
}
.theme-dot[aria-pressed="true"] {
  outline: 2px solid var(--text);
  outline-offset: 2px;
}

.font-chip {
  min-width: 26px;
  padding: 1px 6px;
  border-radius: 6px;
  border: 1px solid var(--border-bright);
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  line-height: 1.5;
}
.font-chip[aria-pressed="true"] {
  background: var(--accent-dim);
  border-color: var(--accent);
}

.theme-dot:focus-visible,
.font-chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .theme-dot {
    transition: none;
  }
}
@media print {
  .picker-bar {
    display: none;
  }
}
```

The active ring uses `var(--text)`, not a fixed white — a hardcoded ring disappears on the four light themes.

## Wiring

Swapping a palette means re-rendering every Mermaid diagram, because Mermaid bakes its colors into the SVG at render time. `templates/mermaid-flowchart.html` already exposes `window.rerenderDiagrams()` for this. Call it; do not write a second insertion path, and do not reach into the template's internals.

Declare the defaults and the current selection first. The template's `mermaid.initialize` reads them, and neither `const` nor `let` is hoisted — declaring them further down throws before the first diagram renders:

```js
const DEFAULT_THEME = "nord";
const DEFAULT_FONT = "bricolage";

let activeTheme = DEFAULT_THEME;
let activeFont = DEFAULT_FONT;
```

Both controls feed one config, so a diagram always reflects the current palette _and_ the current typeface:

```js
function mermaidConfig() {
  return {
    startOnLoad: false,
    theme: "base",
    look: "classic",
    layout: "elk",
    themeVariables: {
      ...mermaidVars(THEMES[activeTheme].css),
      fontFamily: `${FONT_PAIRS[activeFont].sans}, system-ui, sans-serif`,
      fontSize: "16px",
    },
  };
}
```

Write the default theme and font into `:root` in the page CSS as ordinary properties, and build the template's initial call from the same source:

```js
mermaid.initialize(mermaidConfig());
```

Each control then updates its own variables and re-runs the diagrams through the shared path:

```js
function setPressed(selector, key, id) {
  for (const el of document.querySelectorAll(selector)) {
    el.setAttribute("aria-pressed", String(el.dataset[key] === id));
  }
}

async function refresh() {
  mermaid.initialize(mermaidConfig());
  await window.rerenderDiagrams();
}

async function applyTheme(id) {
  const theme = THEMES[id];
  if (!theme) return;
  activeTheme = id;

  const root = document.documentElement;
  for (const [prop, value] of Object.entries(theme.css)) root.style.setProperty(prop, value);
  root.dataset.theme = id;

  setPressed(".theme-dot", "theme", id);
  await refresh();
}

async function applyFont(id) {
  const pair = FONT_PAIRS[id];
  if (!pair) return;
  activeFont = id;

  const root = document.documentElement;
  root.style.setProperty("--font-body", `${pair.sans}, system-ui, sans-serif`);
  root.style.setProperty("--font-mono", `${pair.mono}, monospace`);

  setPressed(".font-chip", "font", id);
  await refresh();
}
```

Key rules:

- `applyTheme` and `applyFont` must be `async`. They await `mermaid.render`, and `await` inside a non-async function is a syntax error that kills the whole script.
- Do not call either on load. The defaults are already live via `:root` and the initial `mermaid.initialize`; calling them would render every diagram twice.
- Never recover diagram source from rendered output. `render` reads `.diagram-source`, which is a separate element from `.mermaid-canvas` and is never overwritten.
- Keep the defaults in `:root` as ordinary CSS so a page without JavaScript still renders in its intended theme and typeface.
- Re-render after a font change, not just a palette change. Mermaid measures label boxes at render time, so a swap without a re-render leaves the old metrics and clips text.

## Exported diagrams

`openInNewTab` writes a standalone page around a clone of the rendered SVG, so its background must follow the live palette rather than a fixed value:

```js
const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0d1117";
```

Mermaid's `clusterBkg` and `tertiaryColor` both derive from `--bg`, so this keeps an exported diagram on the same ground as the page that produced it.

## Default config

Use `visual-explainer.config.md` as the harness-neutral project config. It can set `theme:` and `font:` to the ids from `THEMES` and `FONT_PAIRS`:

```yaml
theme: gruvbox-dark
font: bricolage
```

Claude Code users can keep personal local overrides in `.claude/visual-explainer.local.md`, but shared project defaults should live in `visual-explainer.config.md`. The local Claude file only overrides the harness-neutral file when the agent is running in Claude Code and the user explicitly wants local preferences.

These values seed `DEFAULT_THEME` and `DEFAULT_FONT` only. The reader can still change them, and an unrecognized or absent value falls back to what the page's aesthetic direction would have chosen anyway. This is an agent-readable generation contract, not a native `visual_explainer.render` parameter.
