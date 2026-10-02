# CSS Patterns for Diagrams

Reusable patterns for layout, connectors, theming, and visual effects in self-contained HTML diagrams.

## Theme Setup

Always define both light and dark palettes via custom properties. Start with whichever fits the chosen aesthetic, ensure both work.

```css
:root {
  --font-body: "Outfit", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", Consolas, monospace;

  --bg: #f8f9fa;
  --surface: #ffffff;
  --surface-elevated: #ffffff;
  --border: rgba(0, 0, 0, 0.08);
  --border-bright: rgba(0, 0, 0, 0.15);
  --text: #1a1a2e;
  --text-dim: #6b7280;
  --accent: #0891b2;
  --accent-dim: rgba(8, 145, 178, 0.1);
  /* Semantic accents for diagram elements */
  --node-a: #0891b2;
  --node-a-dim: rgba(8, 145, 178, 0.1);
  --node-b: #059669;
  --node-b-dim: rgba(5, 150, 105, 0.1);
  --node-c: #d97706;
  --node-c-dim: rgba(217, 119, 6, 0.1);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface-elevated: #1c2333;
    --border: rgba(255, 255, 255, 0.06);
    --border-bright: rgba(255, 255, 255, 0.12);
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #22d3ee;
    --accent-dim: rgba(34, 211, 238, 0.12);
    --node-a: #22d3ee;
    --node-a-dim: rgba(34, 211, 238, 0.12);
    --node-b: #34d399;
    --node-b-dim: rgba(52, 211, 153, 0.12);
    --node-c: #fbbf24;
    --node-c-dim: rgba(251, 191, 36, 0.12);
  }
}
```

## Type Scale (rem, one knob for scrollable pages)

For non-slide, scrollable pages, size ordinary page text in `rem` against one root value so one line rescales the page without making reading text too small. The concrete selectors below are copyable CSS and meet the minimum effective sizes at a 16px root. Mermaid SVG labels remain in px because Mermaid sizes them through configuration. Slide decks are a separate contract: preserve their viewport-responsive `clamp(...px, ...vw, ...px)` typography and required `autoFit()` runtime fitting from `slide-patterns.md` and `slide-deck.html` instead of converting slide styles to rem.

```css
/* ONE TYPE KNOB: change this single value to rescale ordinary page text. */
html {
  font-size: 16px;
} /* choose a value in the 16–18px range */

/* Role selectors below meet the minimums at a 16px root. */
h1 {
  font-size: 2rem;
} /* 32px page title */
h2,
.sec-head {
  font-size: 1.25rem;
} /* 20px section heads */
h3,
.card-title {
  font-size: 0.95rem;
} /* 15.2px card titles */
body {
  font-size: 0.875rem;
} /* 14px reading text */
.secondary {
  font-size: 0.75rem;
} /* 12px secondary text */
code,
pre {
  font-size: 0.75rem;
} /* 12px code/mono */
.label,
.tag {
  font-size: 0.6875rem;
} /* 11px labels/tags */
```

When copying older reference snippets, convert ordinary page px values to this scale rather than copying them verbatim. Keep px where a rendering engine or the slide contract requires it.

## Background Atmosphere

Flat backgrounds feel dead. Use subtle gradients or patterns.

```css
/* Radial glow behind focal area */
body {
  background: var(--bg);
  background-image: radial-gradient(ellipse at 50% 0%, var(--accent-dim) 0%, transparent 60%);
}

/* Faint dot grid */
body {
  background-color: var(--bg);
  background-image: radial-gradient(circle, var(--border) 1px, transparent 1px);
  background-size: 24px 24px;
}

/* Diagonal subtle lines */
body {
  background-color: var(--bg);
  background-image: repeating-linear-gradient(
    -45deg,
    transparent,
    transparent 40px,
    var(--border) 40px,
    var(--border) 41px
  );
}

/* Gradient mesh (pick 2-3 positioned radials) */
body {
  background: var(--bg);
  background-image:
    radial-gradient(at 20% 20%, var(--node-a-dim) 0%, transparent 50%),
    radial-gradient(at 80% 60%, var(--node-b-dim) 0%, transparent 50%);
}
```

## Link Styling

**Never rely on browser default link colors.** The default blue (`#0000EE`) has poor contrast on dark backgrounds. Style links with `color: var(--accent)` and keep underlines for discoverability. On dark backgrounds, use bright accents (`#22d3ee`, `#34d399`, `#fbbf24`). On light backgrounds, use deeper tones (`#0891b2`, `#059669`, `#d97706`).

## Section / Card Components

The fundamental building block. A colored card representing a system component, pipeline step, or data entity.

**IMPORTANT: Never use `.node` as a CSS class name.** Mermaid.js internally uses `.node` on its SVG `<g>` elements with `transform: translate(x, y)` for positioning. Any page-level `.node` styles (hover transforms, box-shadows, transitions) will leak into Mermaid diagrams and break their layout. Use `.ve-card` instead (namespaced to avoid collisions with CSS frameworks like Bootstrap/Tailwind that also use `.card`).

```css
.ve-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 20px;
  position: relative;
}

/* Colored accent border (left or top) */
.ve-card--accent-a {
  border-left: 3px solid var(--node-a);
}

/* --- Depth tiers: vary card depth to signal importance --- */

/* Elevated: KPIs, key sections, anything that should pop */
.ve-card--elevated {
  background: var(--surface-elevated);
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.08),
    0 1px 2px rgba(0, 0, 0, 0.04);
}

/* Recessed: code blocks, secondary content, detail panels */
.ve-card--recessed {
  background: color-mix(in srgb, var(--bg) 70%, var(--surface) 30%);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.06);
  border-color: var(--border);
}

/* Hero: executive summaries, focal elements — demands attention */
.ve-card--hero {
  background: color-mix(in srgb, var(--surface) 92%, var(--accent) 8%);
  box-shadow:
    0 4px 20px rgba(0, 0, 0, 0.08),
    0 1px 3px rgba(0, 0, 0, 0.04);
  border-color: color-mix(in srgb, var(--border) 50%, var(--accent) 50%);
}

/* Glass: special-occasion overlay effect (use sparingly) */
.ve-card--glass {
  background: color-mix(in srgb, var(--surface) 60%, transparent 40%);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-color: rgba(255, 255, 255, 0.1);
}

/* Section label (monospace, uppercase, small) */
.ve-card__label {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--node-a);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Colored dot indicator */
.ve-card__label::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
```

## Code Blocks

Code blocks need explicit whitespace preservation and a max-height constraint. Without these, code runs together and long files overwhelm the page.

### Basic Pattern

```css
.code-block {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  overflow-x: auto;
  /* CRITICAL: preserve line breaks and indentation */
  white-space: pre-wrap;
  word-break: break-word;
}

/* Constrain height for long code */
.code-block--scroll {
  max-height: 400px;
  overflow-y: auto;
}
```

```html
<pre class="code-block code-block--scroll"><code>// Your code here
function example() {
  return true;
}</code></pre>
```

### With File Header

```css
.code-file {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.code-file__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
}

.code-file__body {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  padding: 16px;
  background: var(--surface-elevated);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 500px;
  overflow: auto;
}
```

```html
<div class="code-file">
  <div class="code-file__header">
    <span>src/extension.ts</span>
  </div>
  <pre class="code-file__body"><code>export function activate() {
  // ...
}</code></pre>
</div>
```

### Implementation Plans: Don't Dump Full Files

For implementation plans and architecture docs, **don't display entire source files inline**. Instead:

1. **Show structure, not code:**

   ```html
   <div class="file-structure">
     <div class="file-structure__path">src/extension.ts</div>
     <ul class="file-structure__outline">
       <li><code>BOOMERANG_INSTRUCTIONS</code> — System prompt for autonomous mode</li>
       <li><code>clearState()</code> — Reset extension state</li>
       <li><code>updateStatus()</code> — Update UI status indicator</li>
       <li><code>/boomerang</code> command — Start autonomous task</li>
       <li><code>/boomerang-cancel</code> command — Cancel active task</li>
       <li><code>before_agent_start</code> hook — Inject instructions</li>
       <li><code>agent_end</code> hook — Generate summary</li>
     </ul>
   </div>
   ```

2. **Use collapsible sections for full code:**

   ```html
   <details class="collapsible">
     <summary>Full implementation (87 lines)</summary>
     <pre class="code-file__body"><code>...</code></pre>
   </details>
   ```

3. **Show key snippets only:**
   ```html
   <p>The core logic intercepts task completion:</p>
   <pre class="code-block"><code>pi.on("agent_end", async () => {
     const summary = generateSummary(workEntries);
     boomerangComplete = true;
   });</code></pre>
   ```

**Anti-patterns:**

- Displaying full source files inline (100+ lines overwhelming the page)
- Code blocks without `white-space: pre-wrap` (code runs together into unreadable wall)
- No height constraint on long code (page becomes endless scroll)

If someone needs the full file, put it in a collapsible section or link to it.

## Directory Tree

For file structures, use `<pre>` with monospace + `white-space: pre`. Tree connectors (`├──`, `└──`, `│`) only work when vertically aligned — they become noise if text wraps.

```css
.dir-tree {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.7;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 20px;
  overflow-x: auto;
  white-space: pre;
}

.dir-tree .ann {
  color: var(--text-dim);
  font-size: 11px;
  font-style: italic;
}
.dir-tree .hl {
  color: var(--accent);
  font-weight: 600;
}
```

```html
<pre class="dir-tree">my-project/
├── src/
│   ├── <span class="hl">index.ts</span>       <span class="ann">— entry point</span>
│   ├── services/
│   │   └── <span class="hl">api.py</span>     <span class="ann">(142 lines)</span>
│   └── utils/
├── tests/            <span class="ann">(14 test files)</span>
└── README.md</pre>
```

For labeled trees, wrap in a card. For side-by-side comparisons, put two cards in a grid:

```css
.dir-tree-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.dir-tree-card__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1.5px;
}
.dir-tree-card .dir-tree {
  border: none;
  border-radius: 0;
}

/* Side-by-side: two .dir-tree-card in a grid */
.dir-compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  align-items: start;
}
@media (max-width: 900px) {
  .dir-compare {
    grid-template-columns: 1fr;
  }
}
```

**Never** render tree connectors inside wrapping text (`white-space: normal`), flex children, or grid items — the vertical pipes lose alignment and the hierarchy becomes unreadable.

## Overflow Protection

Grid and flex children default to `min-width: auto`, which prevents them from shrinking below their content width. Long text, inline code badges, and non-wrapping elements will blow out containers.

### Global rules

```css
/* Every grid/flex child must be able to shrink */
.grid > *,
.flex > *,
[style*="display: grid"] > *,
[style*="display: flex"] > * {
  min-width: 0;
}

/* Long text wraps instead of overflowing */
body {
  overflow-wrap: break-word;
}
```

### Side-by-side comparison panels

```css
.comparison {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.comparison > * {
  min-width: 0;
  overflow-wrap: break-word;
}

@media (max-width: 768px) {
  .comparison {
    grid-template-columns: 1fr;
  }
}
```

### Never use `display: flex` on `<li>` for marker characters

Using `display: flex` on a list item to position a `::before` marker creates an anonymous flex item for the remaining text content. That anonymous flex item gets `min-width: auto` and you **cannot** set `min-width: 0` on anonymous boxes. Lines with many inline `<code>` badges will overflow their container with no CSS fix possible.

Use absolute positioning for markers instead:

```css
/* WRONG — causes overflow with inline code badges */
li {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
li::before {
  content: "›";
  flex-shrink: 0;
}

/* RIGHT — text wraps normally */
li {
  padding-left: 14px;
  position: relative;
}
li::before {
  content: "›";
  position: absolute;
  left: 0;
}
```

### List markers overlapping container borders

By default, `list-style-position: outside` places list markers (bullets, numbers) outside the content box. When lists are inside bordered containers (cards, callout boxes), the markers can overlap or extend beyond the border.

```css
/* WRONG — markers overlap container border */
.card ol,
.card ul {
  padding-left: 20px; /* Not enough for outside markers */
}

/* RIGHT — use inside positioning */
.card ol,
.card ul {
  list-style-position: inside;
}

/* OR — adequate padding for outside markers */
.card ol,
.card ul {
  padding-left: 2em; /* ~32px gives room for markers */
}

/* OR — custom markers with absolute positioning (most control) */
.card ol {
  list-style: none;
  padding-left: 0;
  counter-reset: item;
}
.card ol li {
  counter-increment: item;
  padding-left: 2em;
  position: relative;
}
.card ol li::before {
  content: counter(item) ".";
  position: absolute;
  left: 0;
  color: var(--accent);
  font-weight: 600;
}
```

**Rule of thumb:** Any `<ol>` or `<ul>` inside a bordered container needs either `list-style-position: inside` or `padding-left: 2em` minimum. The default 20px padding is not enough for outside-positioned markers.

## Mermaid Containers

Mermaid diagrams have two common layout issues: they render too small to read, and they left-align in their container leaving awkward dead space (especially for narrow vertical flowcharts).

### Centering (Required)

Mermaid SVGs render at a fixed size based on content. Without explicit centering, they default to top-left alignment. **Always center Mermaid diagrams** — narrow vertical flowcharts look particularly bad when left-aligned in a wide container.

```css
/* WRONG — diagram hugs left edge */
.mermaid-container {
  padding: 24px;
  border: 1px solid var(--border);
}

/* RIGHT — diagram centers in container */
.mermaid-wrap {
  display: flex;
  justify-content: center;
  align-items: flex-start; /* or center for shorter diagrams */
  padding: 24px;
  border: 1px solid var(--border);
}
```

### Scaling Small Diagrams

Mermaid sizes diagrams based on content, not container. Complex diagrams with many nodes render small to fit everything, leaving the text nearly unreadable. Three fixes:

**1. Increase fontSize in themeVariables** (most effective):

```javascript
mermaid.initialize({
  theme: "base",
  themeVariables: {
    fontSize: "18px", // default is 16px, bump to 18-20px for complex diagrams
  },
});
```

**2. CSS zoom** for diagrams that still render too small:

```css
.mermaid-wrap--scaled .mermaid {
  zoom: 1.3;
}
```

**3. Constrain container width** so the diagram doesn't float in dead space:

```css
.mermaid-wrap--constrained {
  max-width: 800px;
  margin: 0 auto;
}
```

**Rule of thumb:** If the diagram has 10+ nodes or the text is smaller than 12px rendered, increase fontSize to 18-20px or apply CSS zoom.

### Zoom Controls

Add zoom controls to every `.mermaid-wrap` container for complex diagrams.

**Small diagrams in slides.** If a diagram has fewer than ~7 nodes with no branching, it will render tiny in a full-viewport slide container. For simple linear flows (A → B → C → D), use CSS pipeline cards instead of Mermaid — see `slide-patterns.md` "CSS Pipeline Slide." Reserve Mermaid for complex graphs where automatic edge routing is actually needed.

### Full Pattern

```css
.mermaid-wrap {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 32px 24px;
  overflow: auto;
  /* CRITICAL: center the diagram both horizontally and vertically */
  display: flex;
  justify-content: center;
  align-items: center;
  /* Prevent vertical flowcharts from compressing into unreadable thumbnails */
  min-height: 400px;
}

/* For shorter diagrams that don't need the full height */
.mermaid-wrap--compact {
  min-height: 200px;
}

/* For very tall vertical flowcharts */
.mermaid-wrap--tall {
  min-height: 600px;
}

.zoom-controls {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 2px;
  z-index: 10;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px;
}

.zoom-controls button {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 14px;
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.zoom-controls button:hover {
  background: var(--border);
  color: var(--text);
}

.mermaid-wrap {
  cursor: grab;
}
.mermaid-wrap.is-panning {
  cursor: grabbing;
  user-select: none;
}

/* Multi-diagram structure */
.diagram-shell {
  position: relative;
}

.diagram-shell__hint {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 8px;
  opacity: 0.7;
}

.mermaid-viewport {
  position: relative;
  overflow: hidden;
  width: 100%;
  height: 100%;
  min-height: 300px;
}

.mermaid-canvas {
  position: absolute;
  top: 0;
  left: 0;
}

.zoom-label {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
  padding: 0 6px;
  white-space: nowrap;
}
```

**How the new zoom/pan engine works:**

The SVG is rendered into `.mermaid-canvas` which is absolutely positioned inside `.mermaid-viewport`. Zooming sets the SVG's `width` and `height` styles directly. Panning applies `transform: translate()` to the canvas. The viewport has `overflow: hidden` to clip the panned content. This approach avoids CSS `zoom` (which had cross-browser quirks) and gives precise control over the diagram's size and position.

### HTML

```html
<section class="diagram-shell">
  <p class="diagram-shell__hint">
    Ctrl/Cmd + wheel to zoom. Scroll to pan. Drag to pan when zoomed. Double-click to fit.
  </p>
  <div class="mermaid-wrap">
    <div class="zoom-controls">
      <button type="button" data-action="zoom-in" title="Zoom in">+</button>
      <button type="button" data-action="zoom-out" title="Zoom out">&minus;</button>
      <button type="button" data-action="zoom-fit" title="Smart fit">&#8634;</button>
      <button type="button" data-action="zoom-one" title="1:1 zoom">1:1</button>
      <button type="button" data-action="zoom-expand" title="Open full size">&#x26F6;</button>
      <span class="zoom-label">Loading...</span>
    </div>
    <div class="mermaid-viewport">
      <div class="mermaid mermaid-canvas"></div>
    </div>
  </div>
  <script type="text/plain" class="diagram-source">
    graph TD
      A --> B
  </script>
</section>
```

Use one `.diagram-shell` per diagram. The source Mermaid text lives in `<script type="text/plain" class="diagram-source">`, so multiple diagrams can coexist on a page without ID collisions.

### JavaScript

Use a closure-based initializer. Per-diagram state lives inside `initDiagram(shell)`, while shared drag listeners stay at module scope:

```javascript
const config = {
  /* fitPadding, zoom bounds, readabilityFloor */
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
let activeDrag = null;

addEventListener("mousemove", (e) => activeDrag?.onMove(e));
addEventListener("mouseup", () => {
  activeDrag?.onEnd();
  activeDrag = null;
});

function initDiagram(shell) {
  const wrap = shell.querySelector(".mermaid-wrap");
  const viewport = shell.querySelector(".mermaid-viewport");
  const canvas = shell.querySelector(".mermaid-canvas");
  const source = shell.querySelector(".diagram-source");
  const label = shell.querySelector(".zoom-label");

  if (!wrap || !viewport || !canvas || !source || !label) {
    console.error("initDiagram: missing required elements in", shell);
    return;
  }

  // Per-diagram state in closure
  let zoom = 1;
  let fitMode = "contain";
  let panX = 0;
  let panY = 0;
  let svgW = 0;
  let svgH = 0;

  async function render() {
    try {
      const code = source.textContent.trim();
      if (!code) {
        label.textContent = "Error: Empty source";
        return;
      }

      const id = "diagram-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const { svg } = await mermaid.render(id, code);
      const parsed = new DOMParser().parseFromString(svg, "text/html");
      const parsedSvg = parsed.body.querySelector("svg");
      if (!parsedSvg) throw new Error("Mermaid produced no SVG");
      canvas.replaceChildren(document.adoptNode(parsedSvg));

      // readSvgNaturalSize(svgNode) + setAdaptiveHeight() + fitDiagram()
      // wire controls from data-action attributes
      // wire wheel/drag/touch handlers scoped to this shell
    } catch (err) {
      console.error("Mermaid render failed:", err);
      label.textContent = "Error: " + (err.message || "Render failed");
    }
  }

  render();
}

document.querySelectorAll(".diagram-shell").forEach(initDiagram);
```

This pattern removes all hardcoded IDs and supports unlimited diagrams per page. For the full implementation (including smart fit, pinch zoom, and shared drag state), use `templates/mermaid-flowchart.html` as the canonical source.

### Mermaid SVG insertion

Mermaid 10+ can emit HTML inside SVG `<foreignObject>` labels, including unclosed HTML tags such as `<br>`. Do not parse Mermaid output with `DOMParser(..., 'image/svg+xml')`: the strict XML parser can silently truncate labels or edges. Avoid `canvas.innerHTML = svg` in reusable templates too, because security scanners often flag it as an HTML sink.

Use `DOMParser(..., 'text/html')`, then adopt the parsed `<svg>` node into the canvas. The HTML parser accepts Mermaid's label markup and preserves the SVG namespace for browser rendering.

## Grid Layouts

### Architecture Diagram (2-column with sidebar)

```css
.arch-grid {
  display: grid;
  grid-template-columns: 260px 1fr;
  grid-template-rows: auto;
  gap: 20px;
  max-width: 1100px;
  margin: 0 auto;
}

.arch-grid__sidebar {
  grid-column: 1;
}
.arch-grid__main {
  grid-column: 2;
}
.arch-grid__full {
  grid-column: 1 / -1;
}
```

### Pipeline (horizontal steps)

```css
.pipeline {
  display: flex;
  align-items: stretch;
  gap: 0;
  overflow-x: auto;
  padding-bottom: 8px;
}

.pipeline__step {
  min-width: 130px;
  flex-shrink: 0;
}

.pipeline__arrow {
  display: flex;
  align-items: center;
  padding: 0 4px;
  color: var(--border-bright);
  font-size: 18px;
  flex-shrink: 0;
}

/* Parallel branch within a pipeline */
.pipeline__parallel {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
```

### Card Grid (dashboard / metrics)

```css
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}
```

### Data Tables

Use real `<table>` elements for tabular data. Wrap in a scrollable container for wide tables.

```css
/* Scrollable wrapper for wide tables */
.table-wrap {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}

.table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

/* Base table */
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  line-height: 1.5;
}

/* Header */
.data-table thead {
  position: sticky;
  top: 0;
  z-index: 2;
}

.data-table th {
  background: var(--surface-elevated, var(--surface2, var(--surface)));
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-dim);
  text-align: left;
  padding: 12px 16px;
  border-bottom: 2px solid var(--border-bright);
  white-space: nowrap;
}

/* Cells */
.data-table td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  color: var(--text);
}

/* Let text-heavy columns wrap naturally */
.data-table .wide {
  min-width: 200px;
  max-width: 500px;
}

/* Right-align numeric columns */
.data-table td.num,
.data-table th.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}

/* Alternating rows */
.data-table tbody tr:nth-child(even) {
  background: var(--accent-dim);
}

/* Row hover */
.data-table tbody tr {
  transition: background 0.15s ease;
}

.data-table tbody tr:hover {
  background: var(--border);
}

/* Last row: no bottom border (container handles it) */
.data-table tbody tr:last-child td {
  border-bottom: none;
}

/* Code inside cells */
.data-table code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--accent-dim);
  color: var(--accent);
  padding: 1px 5px;
  border-radius: 3px;
}

/* Secondary detail text */
.data-table small {
  display: block;
  color: var(--text-dim);
  font-size: 11px;
  margin-top: 2px;
}
```

#### Status Indicators

Styled spans for match/gap/warning states. Never use emoji.

```css
.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 6px;
  white-space: nowrap;
}

.status--match {
  background: var(--green-dim, rgba(5, 150, 105, 0.1));
  color: var(--green, #059669);
}

.status--gap {
  background: var(--red-dim, rgba(239, 68, 68, 0.1));
  color: var(--red, #ef4444);
}

.status--warn {
  background: var(--orange-dim, rgba(217, 119, 6, 0.1));
  color: var(--orange, #d97706);
}

.status--info {
  background: var(--accent-dim);
  color: var(--accent);
}

/* Dot variant (compact, no text) */
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.status-dot--match {
  background: var(--green, #059669);
}
.status-dot--gap {
  background: var(--red, #ef4444);
}
.status-dot--warn {
  background: var(--orange, #d97706);
}
```

Usage in table cells:

```html
<td><span class="status status--match">Match</span></td>
<td><span class="status status--gap">Gap</span></td>
<td><span class="status status--warn">Partial</span></td>
```

#### Table Summary Row

For totals, counts, or aggregate status at the bottom:

```css
.data-table tfoot td {
  background: var(--surface-elevated, var(--surface2, var(--surface)));
  font-weight: 600;
  font-size: 12px;
  border-top: 2px solid var(--border-bright);
  border-bottom: none;
  padding: 12px 16px;
}
```

#### Sticky First Column (for very wide tables)

```css
.data-table th:first-child,
.data-table td:first-child {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--surface);
}

.data-table tbody tr:nth-child(even) td:first-child {
  background: color-mix(in srgb, var(--surface) 95%, var(--accent) 5%);
}
```

## Connectors

### CSS Arrow (vertical, between stacked sections)

```css
.flow-arrow {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 6px 0;
}

/* Down arrow via SVG icon */
.flow-arrow svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: var(--border-bright);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
```

Down arrow SVG (reuse inline):

```html
<svg viewBox="0 0 20 20"><path d="M10 4 L10 16 M6 12 L10 16 L14 12" /></svg>
```

### CSS Arrow (horizontal, between inline steps)

Use `::after` or a literal arrow character:

```css
.h-arrow::after {
  content: "→";
  color: var(--border-bright);
  font-size: 18px;
  padding: 0 4px;
}
```

### SVG Curved Connector (between arbitrary nodes)

For connections that aren't simple vertical/horizontal, use an absolutely positioned SVG overlay:

```html
<svg
  class="connectors"
  style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;"
>
  <path
    d="M 150,100 C 150,200 350,100 350,200"
    fill="none"
    stroke="var(--accent)"
    stroke-width="1.5"
    stroke-dasharray="4 3"
  />
  <!-- Arrowhead -->
  <polygon points="348,195 352,205 356,195" fill="var(--accent)" />
</svg>
```

Position the parent container as `position: relative` to scope the SVG overlay.

## Animations

### Staggered Fade-In on Load

Define the keyframe once, then stagger via a `--i` CSS variable set per element. This approach works regardless of DOM nesting or interleaved non-animated elements (unlike `nth-child` which breaks when siblings aren't all the same type).

```css
@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.ve-card {
  animation: fadeUp 0.4s ease-out both;
  animation-delay: calc(var(--i, 0) * 0.05s);
}
```

Set `--i` per element in the HTML to control stagger order:

```html
<div class="ve-card" style="--i: 0">First</div>
<div class="connector">...</div>
<div class="ve-card" style="--i: 1">Second</div>
<div class="connector">...</div>
<div class="ve-card" style="--i: 2">Third</div>
```

### Hover Lift

```css
.ve-card {
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
}

.ve-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}
```

### Scale-Fade (for KPI cards, badges, status indicators)

```css
@keyframes fadeScale {
  from {
    opacity: 0;
    transform: scale(0.92);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.kpi-card {
  animation: fadeScale 0.35s ease-out both;
  animation-delay: calc(var(--i, 0) * 0.06s);
}
```

### SVG Draw-In (for connectors, progress rings, path elements)

```css
@keyframes drawIn {
  from {
    stroke-dashoffset: var(--path-length);
  }
  to {
    stroke-dashoffset: 0;
  }
}

/* Set --path-length to the path's getTotalLength() value */
.connector path {
  stroke-dasharray: var(--path-length);
  animation: drawIn 0.8s ease-in-out both;
  animation-delay: calc(var(--i, 0) * 0.1s);
}
```

### CSS Counter (for hero numbers without JS)

Uses `@property` to animate a custom property as an integer, then display it via `counter()`. No JS required. Falls back to showing the final value immediately in browsers without `@property` support.

```css
@property --count {
  syntax: "<integer>";
  initial-value: 0;
  inherits: false;
}

@keyframes countUp {
  to {
    --count: var(--target);
  }
}

.kpi-card__value--animated {
  --target: 247;
  counter-reset: val var(--count);
  animation: countUp 1.2s ease-out forwards;
}

.kpi-card__value--animated::after {
  content: counter(val);
}
```

### Choreography

Don't use the same animation for everything. Mix types by element role, with easing stagger (fast-then-slow, not linear):

- **Cards**: `fadeUp` — the default entrance, reliable and subtle
- **KPI / badges**: `fadeScale` — scale draws the eye to important numbers
- **SVG connectors**: `drawIn` — reveals flow direction, pairs with card stagger
- **Hero numbers**: `countUp` — counting motion signals "this number matters"
- **Stagger timing**: `calc(var(--i) * 0.06s)` with lower `--i` values on important elements so they appear first

### Respect Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

## Sparklines and Simple Charts (Pure SVG)

For simple inline visualizations without a library:

```html
<!-- Sparkline -->
<svg viewBox="0 0 100 30" style="width:100px;height:30px;">
  <polyline
    points="0,25 15,20 30,22 45,10 60,15 75,5 90,12 100,8"
    fill="none"
    stroke="var(--accent)"
    stroke-width="1.5"
    stroke-linecap="round"
  />
</svg>

<!-- Progress bar -->
<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;">
  <div style="height:100%;width:72%;background:var(--accent);border-radius:3px;"></div>
</div>
```

## Responsive Breakpoint

Include a single breakpoint for narrow viewports:

```css
@media (max-width: 768px) {
  .arch-grid {
    grid-template-columns: 1fr;
  }
  .pipeline {
    flex-wrap: wrap;
    gap: 8px;
  }
  .pipeline__arrow {
    display: none;
  }
  body {
    padding: 16px;
  }
}
```

## Badges and Tags

Small inline labels for categorizing elements:

```css
.tag {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--node-a-dim);
  color: var(--node-a);
}
```

## Lists Inside Nodes

For tool listings, feature lists, table columns:

```css
.node-list {
  list-style: none;
  padding: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
}

.node-list li {
  padding-left: 14px;
  position: relative;
}

.node-list li::before {
  content: "›";
  color: var(--text-dim);
  font-weight: 600;
  position: absolute;
  left: 0;
}

.node-list code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--accent-dim);
  color: var(--accent);
  padding: 1px 5px;
  border-radius: 3px;
}
```

## KPI / Metric Cards

Large hero number with trend indicator and label. For dashboards, review summaries, and impact sections.

```css
.kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px;
}

.kpi-card {
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.kpi-card__value {
  font-size: 36px;
  font-weight: 700;
  letter-spacing: -1px;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.kpi-card__label {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--text-dim);
  margin-top: 6px;
}

.kpi-card__trend {
  font-family: var(--font-mono);
  font-size: 12px;
  margin-top: 4px;
}

.kpi-card__trend--up {
  color: var(--node-b, #059669);
}
.kpi-card__trend--down {
  color: var(--red, #ef4444);
}
```

```html
<div class="kpi-row">
  <div class="kpi-card">
    <div class="kpi-card__value">247</div>
    <div class="kpi-card__label">Lines Added</div>
    <div class="kpi-card__trend kpi-card__trend--up">+34%</div>
  </div>
  <!-- ... more cards -->
</div>
```

## Before / After Panels

Two-column comparison with diff-colored headers. For review pages, migration docs, and feature comparisons.

```css
.diff-panels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

.diff-panels > * {
  min-width: 0;
  overflow-wrap: break-word;
}

.diff-panel__header {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  padding: 10px 16px;
}

.diff-panel__header--before {
  background: var(--red-dim, rgba(239, 68, 68, 0.08));
  color: var(--red, #ef4444);
  border-bottom: 2px solid var(--red, #ef4444);
}

.diff-panel__header--after {
  background: var(--green-dim, rgba(5, 150, 105, 0.08));
  color: var(--green, #059669);
  border-bottom: 2px solid var(--green, #059669);
}

.diff-panel__body {
  padding: 16px;
  background: var(--surface);
  font-size: 13px;
  line-height: 1.6;
}

/* Highlight changed items within a panel */
.diff-changed {
  background: var(--accent-dim);
  border-radius: 3px;
  padding: 0 3px;
}

@media (max-width: 768px) {
  .diff-panels {
    grid-template-columns: 1fr;
  }
}
```

```html
<div class="diff-panels">
  <div class="diff-panel__header diff-panel__header--before">Before</div>
  <div class="diff-panel__header diff-panel__header--after">After</div>
  <div class="diff-panel__body">Previous implementation...</div>
  <div class="diff-panel__body">New implementation...</div>
</div>
```

## Collapsible Sections

Native `<details>/<summary>` with styled disclosure. Zero JS, accessible. For lower-priority content: file maps, decision logs, reference sections.

```css
details.collapsible {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

details.collapsible summary {
  padding: 14px 20px;
  background: var(--surface);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  transition: background 0.15s ease;
}

details.collapsible summary:hover {
  background: var(--surface-elevated, var(--surface));
}

details.collapsible summary::-webkit-details-marker {
  display: none;
}

/* Chevron indicator */
details.collapsible summary::before {
  content: "▸";
  font-size: 11px;
  color: var(--text-dim);
  transition: transform 0.15s ease;
}

details.collapsible[open] summary::before {
  transform: rotate(90deg);
}

details.collapsible .collapsible__body {
  padding: 16px 20px;
  border-top: 1px solid var(--border);
  font-size: 13px;
  line-height: 1.6;
}
```

```html
<details class="collapsible">
  <summary>File Map (14 files changed)</summary>
  <div class="collapsible__body">
    <!-- content here -->
  </div>
</details>
```

## Prose Page Elements

Patterns for documentation, articles, blog posts, and other reading-first content. The key difference from visual explanations: optimize for sustained reading, not scanning.

### Body Text Settings

```css
/* Comfortable reading baseline */
.prose {
  font-size: clamp(17px, 1.1vw + 14px, 19px);
  line-height: 1.7;
  max-width: 65ch; /* ~600-680px */
  text-wrap: pretty;
}

.prose p {
  margin-bottom: 1.5em;
}

/* Narrow column for essays/literary content */
.prose--narrow {
  max-width: 60ch;
  line-height: 1.8;
}

/* Wide column for technical content with code */
.prose--wide {
  max-width: 75ch;
  line-height: 1.6;
}
```

### Lead Paragraph

Opening paragraph styled distinctly from body text.

```css
/* Larger size */
.lead {
  font-size: 20px;
  line-height: 1.6;
  color: var(--text-bright);
  margin-bottom: 32px;
}

/* With drop cap */
.lead--dropcap::first-letter {
  float: left;
  font-family: var(--font-display);
  font-size: 64px;
  font-weight: 600;
  line-height: 0.85;
  padding-right: 12px;
  padding-top: 6px;
  color: var(--accent);
}
```

### Pull Quotes

Key insights pulled out for emphasis. Use sparingly — one or two per article maximum.

```css
/* Border left — most versatile */
.pullquote {
  margin: 48px 0;
  padding-left: 24px;
  border-left: 3px solid var(--accent);
}
.pullquote p {
  font-size: 22px;
  font-style: italic;
  line-height: 1.4;
  color: var(--text-bright);
  margin: 0;
}

/* Centered with quotation mark */
.pullquote--centered {
  margin: 56px 0;
  padding: 32px 40px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  text-align: center;
  position: relative;
}
.pullquote--centered::before {
  content: '"';
  position: absolute;
  top: -12px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg);
  padding: 0 16px;
  font-family: var(--font-display);
  font-size: 48px;
  color: var(--accent);
  line-height: 1;
}
```

### Section Dividers

```css
/* Horizontal rule */
hr {
  border: none;
  height: 1px;
  background: var(--border);
  margin: 48px 0;
}

/* Ornamental divider — use: <div class="divider">✦ ✦ ✦</div> */
.divider {
  text-align: center;
  margin: 48px 0;
  color: var(--text-dim);
  font-size: 18px;
  letter-spacing: 12px;
}
```

### Article Hero Patterns

```css
/* Centered minimal — essays, personal posts */
.hero--centered {
  text-align: center;
  padding: 80px 24px 64px;
  max-width: 800px;
  margin: 0 auto;
}
.hero__category {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--accent);
  margin-bottom: 16px;
}
.hero__title {
  font-size: clamp(32px, 5vw, 48px);
  font-weight: 600;
  line-height: 1.15;
  margin-bottom: 16px;
}
.hero__subtitle {
  font-size: 20px;
  font-style: italic;
  color: var(--text-dim);
  max-width: 600px;
  margin: 0 auto 24px;
}
.hero__meta {
  font-size: 13px;
  color: var(--text-dim);
}

/* Left-aligned editorial — features, documentation */
.hero--editorial {
  padding: 100px 40px 60px;
  max-width: 1000px;
  margin: 0 auto;
}
.hero--editorial .hero__title {
  font-size: clamp(40px, 7vw, 72px);
  font-weight: 800;
  line-height: 1;
  letter-spacing: -2px;
}
```

### Author Byline

```css
.byline {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 24px;
}
.byline__avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
}
.byline__name {
  font-weight: 600;
  color: var(--text-bright);
  display: block;
}
.byline__meta {
  font-size: 13px;
  color: var(--text-dim);
}
```

### Callout Boxes

For warnings, tips, notes, and key takeaways.

```css
.callout {
  padding: 16px 20px;
  border-radius: 8px;
  border-left: 4px solid var(--callout-border);
  background: var(--callout-bg);
  margin: 24px 0;
}

.callout--info {
  --callout-border: var(--accent);
  --callout-bg: color-mix(in srgb, var(--accent) 10%, transparent);
}

.callout--warning {
  --callout-border: var(--amber);
  --callout-bg: color-mix(in srgb, var(--amber) 10%, transparent);
}

.callout--success {
  --callout-border: var(--green);
  --callout-bg: color-mix(in srgb, var(--green) 10%, transparent);
}

.callout__title {
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--callout-border);
}

/* Lists inside callouts need padding fix */
.callout ul,
.callout ol {
  padding-left: 1.5em;
  margin: 8px 0 0 0;
}
```

### Theme Toggle

Use `data-theme` attribute for user-controllable light/dark modes. Random initial theme adds variety.

```css
:root,
[data-theme="light"] {
  --bg: #fafaf9;
  --surface: #ffffff;
  --text: #1c1917;
  --text-dim: #78716c;
  --border: #e7e5e4;
  --accent: #0d9488;
}

[data-theme="dark"] {
  --bg: #0c0a09;
  --surface: #1c1917;
  --text: #fafaf9;
  --text-dim: #a8a29e;
  --border: #292524;
  --accent: #14b8a6;
}
```

```javascript
// Random initial theme
const themes = ["light", "dark"];
document.documentElement.setAttribute("data-theme", themes[Math.floor(Math.random() * 2)]);

// Toggle function
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  document.documentElement.setAttribute("data-theme", current === "light" ? "dark" : "light");
}
```

```html
<button class="theme-toggle" onclick="toggleTheme()" aria-label="Toggle theme">
  <svg
    class="theme-toggle__sun"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
  >
    <circle cx="12" cy="12" r="5" />
    <path
      d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
    />
  </svg>
  <svg
    class="theme-toggle__moon"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
</button>
```

```css
.theme-toggle {
  position: fixed;
  top: 20px;
  right: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  cursor: pointer;
  z-index: 100;
}
[data-theme="light"] .theme-toggle__moon {
  display: none;
}
[data-theme="dark"] .theme-toggle__sun {
  display: none;
}
```

### Prose Anti-Patterns

Avoid these in reading-first content:

- Body text smaller than 16px
- Line-height below 1.5
- Measure wider than 75ch (text spanning full viewport)
- Pull quotes every other paragraph
- Drop caps on every section
- Busy background patterns behind text

## Generated Images

For AI-generated illustrations embedded as base64 data URIs via `surf gemini --generate-image`. Use sparingly — hero banners, conceptual illustrations, educational diagrams, decorative accents.

### Hero Banner

Full-width image cropped to a fixed height with a gradient fade into the page background. Place at the top of the page before the title, or between the title and the first content section.

```css
.hero-img-wrap {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 24px;
}

.hero-img-wrap img {
  width: 100%;
  height: 240px;
  object-fit: cover;
  display: block;
}

/* Gradient fade into page background */
.hero-img-wrap::after {
  content: "";
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 50%;
  background: linear-gradient(to top, var(--bg), transparent);
  pointer-events: none;
}
```

```html
<div class="hero-img-wrap">
  <img src="data:image/png;base64,..." alt="Descriptive alt text" />
</div>
```

Generate with `--aspect-ratio 16:9` for hero banners.

### Inline Illustration

Centered image with border, shadow, and optional caption. Use within content sections for conceptual or educational illustrations.

```css
.illus {
  text-align: center;
  margin: 24px 0;
}

.illus img {
  max-width: 480px;
  width: 100%;
  border-radius: 10px;
  border: 1px solid var(--border);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

.illus figcaption {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 8px;
}
```

```html
<figure class="illus">
  <img src="data:image/png;base64,..." alt="Descriptive alt text" />
  <figcaption>How the message queue routes events between services</figcaption>
</figure>
```

Generate with `--aspect-ratio 1:1` or `--aspect-ratio 4:3` for inline illustrations.

### Side Accent

Small image floated beside a section. Use when the illustration supports but doesn't dominate the content.

```css
.accent-img {
  float: right;
  max-width: 200px;
  margin: 0 0 16px 24px;
  border-radius: 10px;
  border: 1px solid var(--border);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

@media (max-width: 768px) {
  .accent-img {
    float: none;
    max-width: 100%;
    margin: 0 0 16px 0;
  }
}
```

```html
<img class="accent-img" src="data:image/png;base64,..." alt="Descriptive alt text" />
```
