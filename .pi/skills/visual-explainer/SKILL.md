---
name: visual-explainer
description: Generate self-contained HTML visual explanations for systems, code changes, plans, data, and technical concepts. Use for diagrams, architecture overviews, diff or plan reviews, project recaps, comparison tables, slide decks, and other visual explanations.
license: MIT
compatibility: Requires a browser to view generated HTML files. Optional surf-cli for AI image generation.
metadata:
  author: nicobailon
  version: "0.11.0"
---

# Visual Explainer

Generate self-contained HTML pages that explain systems, code changes, plans, data, and technical concepts visually. Use this skill for diagram requests, architecture overviews, diff/plan reviews, project recaps, comparison tables, slide decks, and any visual explanation.

## Trigger and delivery rules

- Prefer an HTML page over terminal ASCII when the output is inherently visual.
- If a table would have 4+ rows or 3+ columns, render it as HTML and give only a short chat summary.
- Write files to `~/.agent/diagrams/` or the explicit eval output path. Use descriptive filenames.
- Generate a Markdown companion only when the user explicitly asks for AI-readable output or a source brief. Keep HTML as the final visual output; Markdown is a companion, never the source for HTML. Write `<name>.md` beside `<name>.html` when possible, and ask before replacing an existing companion file.
- Open generated pages in the browser when running normally. In Pi package installs, use `visual_explainer` with `prepare` for planning/context and `render` only after the complete HTML document exists. MCP hosts use `visual-explainer-mcp`, which defaults render tools to `open: false`. Use `viewer: "glimpse"` only when the user wants a native Glimpse window and `glimpseui` is installed; `viewer: "auto"` may fall back to the browser.
- The final page must be a complete self-contained HTML document, including embedded CSS, a self-contained favicon, and any needed JS. In Pi, `visual_explainer.render` also adds missing `html lang`, missing viewport metadata, and display-math escaping for raw `<` / `>` inside `$$...$$`.

## Quick mode

Quick mode is opt-in. Use it only when `--quick` appears on `/generate-web-diagram`, `/diff-review`, `/plan-review`, or `/project-recap`. Default and all other prompt behavior remains full HTML generation.

For quick mode, read `./quick/README.md` and `./quick/schema.json`. Gather and verify the same source facts as full mode, but emit the compact JSON spec. In Pi, call the existing `visual_explainer` tool with `action: "render_quick"`, `filename`, `spec`, and optional `open` or `viewer`. In other harnesses, save the JSON and call the local `./quick/render.mjs` script. The renderer validates the spec and creates the complete HTML document.

Quick mode is not suitable for custom visual composition, slides, Mermaid-rich topology, or content that the schema cannot express. If it is not a fit, schema validation fails, or rendering errors, fall back to the normal full HTML workflow and render action. Do not use quick mode for slides, fact-check, visual plans, PPTX, themes, or updates.

## Design judgment

Before writing any HTML:

- Calibrate treatment: diff reviews, memos, audits, and recaps get polished-utilitarian (real hierarchy, considered spacing, no flashy hero); showcases and narrative decks get editorial. A well-composed page is never wrong; an over-designed one sometimes is.
- Precedence: the user's words, then the project's existing design system (theme/token files, component styles), then this skill's choices. Check repo tokens before picking a palette for diff/plan reviews.
- Plan first: 4–6 named hex values, type roles, a one-sentence layout concept. Audit once — "would I produce this plan for any similar page?" — and revise the generic parts. (Generic: slate `#0f172a`, indigo, Inter, hero plus three cards. Revised for a CLI recap: near-black green, phosphor text, amber accent, JetBrains Mono — terminal direction, layout follows the release timeline.)
- Structure must encode something true: 01/02/03 markers only when order matters, eyebrow labels only when they classify, dividers only at real seams.

## Reference routing

Read only the references needed for the current output:

| Need                                                                                    | Read                                                                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Text-heavy architecture/cards                                                           | `./templates/architecture.html`                                                       |
| Mermaid flowcharts, sequence, ER, state, class, C4, data flow                           | `./templates/mermaid-flowchart.html`, Mermaid sections in `./references/libraries.md` |
| Data tables, comparisons, audits                                                        | `./templates/data-table.html`                                                         |
| Slide decks                                                                             | `./templates/slide-deck.html`, `./references/slide-patterns.md`                       |
| CSS layout, type scale, overflow, depth, collapsibles, SVG connectors, generated images | `./references/css-patterns.md`                                                        |
| Pages with 4+ major sections                                                            | `./references/responsive-nav.md`                                                      |
| Switchable themes or fonts, or a named palette (Dracula, Nord, Gruvbox…)                | `./references/themes.md`                                                              |
| Prose-heavy pages                                                                       | “Prose Page Elements” in `css-patterns.md`, typography sections in `libraries.md`     |

## Choose the representation

| Content                                                         | Default representation                             |
| --------------------------------------------------------------- | -------------------------------------------------- |
| Flowchart, pipeline, state machine, decision tree               | Mermaid                                            |
| Sequence, ER/schema, class, C4, topology-focused architecture   | Mermaid                                            |
| Text-heavy architecture, module internals, implementation plans | CSS grid cards, optionally with a Mermaid overview |
| 15+ element architecture                                        | Hybrid: small Mermaid overview + CSS detail cards  |
| Comparison/audit/status matrix                                  | Semantic HTML `<table>`                            |
| Timeline/roadmap                                                | CSS timeline                                       |
| Dashboard/metrics                                               | CSS grid + charts/KPIs                             |
| Slide deck                                                      | `100dvh` slides using slide template patterns      |

## Mermaid invariants

What to draw, before how:

- Depict the mechanism, not its name: the path a request takes through a cache says more than a box labeled "cache".
- Label every arrow (`writes`, `invalidates`, `polls every 30s`); an unlabeled arrow only says "related somehow".
- To compare options, draw the difference — the edge each adds or removes. Match complexity to what the decision turns on.
- One figure, one claim; the caption states it.

How to render:

- Use `theme: 'base'` with custom `themeVariables` matching the page palette.
- For complex diagrams use ELK layout when available.
- Never use bare `<pre class="mermaid">`.
- Use the canonical `diagram-shell` pattern from `templates/mermaid-flowchart.html`: `.diagram-shell` > `.mermaid-wrap` > `.zoom-controls` + `.mermaid-viewport` > `.mermaid-canvas`.
- Every Mermaid diagram needs zoom in/out/reset/expand controls, Ctrl/Cmd+scroll zoom, drag panning, and click-to-expand.
- Prefer `flowchart TD` for complex diagrams. Use `LR` only for simple 3–4 node linear flows.
- Use `<br/>` in quoted flowchart labels. Do not use escaped `\n` labels.
- Never define page-level `.node`; Mermaid uses it internally. Use namespaced page classes such as `.ve-card`.
- For 15+ elements, do not cram everything into one Mermaid diagram. Use the hybrid overview + cards pattern.

## Layout and style invariants

- Use semantic HTML where it helps accessibility and copy/paste: `<table>`, headings, lists, `<details>`, captions.
- Use CSS custom properties for palette: `--bg`, `--surface`, `--border`, `--text`, `--text-dim`, and 3–5 accents.
- Pages meant to persist ship both color schemes: tokens on `:root`, the `prefers-color-scheme` media query redefines tokens only, components styled through tokens. Pick the second theme's values; never invert. Single-theme is fine when deliberate (one-shot pages, quick mode, `themes.md` picker).
- Commit to one palette (with its light and dark scheme variants) and one font pair. Add a runtime picker only when the user asks to switch themes or fonts, or names a prebuilt palette; see `./references/themes.md`.
- Anchor the aesthetic direction to the content's domain: CLI/infra → terminal or IDE-inspired; metrics/audits → data-dense; plans/architecture → blueprint; recaps → editorial; prose → paper/ink. Warm cream + serif + terracotta on everything is itself a cliché.
- Avoid generic defaults when choosing freely (a project's existing design system overrides this list): no body font that is only Inter, Roboto, Arial, Helvetica, or system-ui; no violet/fuchsia Tailwind-default accents as the main palette (`#8b5cf6`, `#7c3aed`, `#a78bfa`, `#d946ef`); no cyan+magenta+purple neon dashboard; no gradient-mesh blobs; no purple-to-blue gradient heroes, emoji section markers, centered-everything layouts, uniform large border-radius, or default accent bars on rounded cards.
- Set type deliberately: running text near 65ch, a committed type scale, `text-wrap: balance` on headings, letter-spacing on uppercase labels.
- For non-slide, scrollable pages, use a rem-based type scale with one root knob: set `html { font-size: 16px }` (choose a value in the 16–18px range) and express ordinary page text in `rem`, so a single line rescales the page. Minimum effective sizes at the chosen root: body/reading text ≥ 14px, secondary text and labels ≥ 11px, code/mono ≥ 12px. Never hard-code reading text below 14px in px — dense all-px scales render as unreadable dashboards. Mermaid SVG labels remain in px because Mermaid sizes them through configuration. Slide decks are a deliberate exception: preserve their viewport-responsive `clamp(...px, ...vw, ...px)` typography and `autoFit()` runtime fitting from `slide-patterns.md` and `slide-deck.html`; do not force slide styles into rem. Reference snippets and templates demonstrate structure; re-scale ordinary page px values when copying them.
- Bias neutrals toward the accent hue; pure mid-grey reads as unconsidered. Space siblings with flex/grid `gap`, not collapsing margins; `tabular-nums` where digits align in columns; watch specificity so classes do not silently cancel each other's spacing.
- Microcopy is design material: name things by what readers recognize, not internal structure; controls say exactly what happens; specific beats clever.
- Dashboards are scanned, not read: summary before detail; encode state in form (pills, chips, severity stripes); keep semantic color separate from the accent hue; interactive things look interactive.
- Good font pair families: DM Sans + Fira Code; Instrument Serif + JetBrains Mono; IBM Plex Sans + IBM Plex Mono; Bricolage Grotesque + JetBrains Mono; Plus Jakarta Sans + Azeret Mono.
- Load every font weight the CSS uses, including mono labels. Do not rely on faux-bold for 500, 600, or 700 weights.
- Good accent directions: terracotta+sage, teal+slate, rose+cranberry, amber+emerald, deep blue+gold.
- Prevent overflow: `min-width: 0` on grid/flex children, `overflow-wrap: break-word` for long text, and scroll containers for wide tables/code.
- Do not set `display: flex` directly on `<li>` when list markers matter.
- Use depth sparingly: hero/elevated only for primary sections; flat/recessed for reference material.
- Use entrance/hover animation only when it clarifies hierarchy. Respect `prefers-reduced-motion`. Do not use continuous glow, pulse, or breathing effects on static content.

## Slide deck mode

Use slides only when explicitly requested or when a command asks for slides. Slides are a different medium, not a paginated article. If the user explicitly asks for PPTX or passes `--pptx` to `/generate-slides`, generate the HTML deck first, then use the best-effort static exporter in `./pptx/export.mjs` or the `visual-explainer-pptx` binary when package or checkout dependencies are available. If they are not available, deliver the HTML deck and explain the missing export dependency path. State that HTML remains the source of truth and PPTX does not preserve animations, reader navigation, responsive layout, custom fonts, live Mermaid/Chart.js/SVG/canvas rendering, or JavaScript behavior.

Slides rules:

- Each slide gets one `100dvh` viewport budget with no page-level scrolling. The template's `overflow: hidden` can clip excess content silently, so enable `prefers-reduced-motion: reduce` at target and short landscape heights, then fix every vertical-overflow or `autoFit()` warning before delivery.
- Use larger type, fewer objects per slide, varied compositions, and visible navigation.
- Include slide nav chrome from `slide-deck.html`: prev/next controls, slide count with reading percent, keyboard navigation, expandable reader rail, outline/help overlays, `#slide-N` deep links, and resume state.
- Before writing HTML, inventory the source and map every source item to slides.
- Do not drop content to fit a fixed slide count. Add slides instead.
- Use the 10 slide types from `slide-patterns.md`: Title, Section Divider, Content, Split, Diagram, Dashboard, Table, Code, Quote, Full-Bleed.

## Optional generated images

If `surf` is available, generated images may be embedded as base64 for hero banners, conceptual illustrations, or educational visuals. Skip images for data-heavy, structural, or Mermaid/CSS-suitable content. Pages must stand on CSS, typography, and diagrams without images.

## Final checklist

Before delivery, verify:

- complete HTML document;
- output written to the requested path;
- no console errors when opened;
- no horizontal overflow at normal desktop width;
- fonts load with fallbacks;
- page has a self-contained favicon;
- tables preserve rows/columns and wrap long text;
- interactive elements have visible keyboard focus states;
- diagrams sit in `<figure>` with a claim-stating `figcaption`, plus `role="img"` and a matching `aria-label` on the shell wrapper, not the Mermaid SVG (re-renders replace it);
- both color schemes hold up, or single-theme was deliberate;
- Mermaid diagrams use `diagram-shell` with zoom/pan/expand;
- a runtime picker, if present, swaps palette and font variables and re-renders every diagram;
- slides fit one viewport, include reader rail plus outline/help navigation, preserve source coverage, and pass the template's overflow/autoFit delivery check under reduced motion; if PPTX was requested, the static `.pptx` was generated after the HTML deck and its fidelity limits were stated;
- non-slide, scrollable page type uses rem with one root knob and meets the minimum effective sizes (body ≥ 14px, labels ≥ 11px, mono ≥ 12px); Mermaid SVG labels may remain config-driven px, while slide decks retain their `clamp()` typography and `autoFit()` runtime fitting;
- visual hierarchy makes the main idea obvious in the first viewport;
- styling would still be recognizable if compared against a generic dark/violet template;
- if requested, the Markdown companion is a concise source brief that matches the delivered HTML without becoming its source of truth.
