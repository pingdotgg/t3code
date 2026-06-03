# Alchemy Design System

> **Infrastructure-as-Effects** — a TypeScript framework that unifies cloud
> infrastructure and application logic into a single type-safe program
> powered by [Effect](https://effect.website).

Alchemy is a developer-tool brand: terminal-first, code-dense, dark-mode only,
with one signature color — mint green `#00e599`. Marketing moments lean on
**hand-drawn sketch diagrams** (arrows, circles, scribbled labels) to explain
abstract type-system concepts. Everything else is flat, quiet, and close to
black.

This design system captures the visuals, tone, and components needed to ship
new marketing pages, docs, social posts, and slide decks that feel like
Alchemy — without re-inventing tokens each time.

---

## Sources

- **Repo:** `github.com/alchemy-run/alchemy-effect` — website (Astro +
  Starlight), README, docs content, raw sketch PNGs under `images/`.
- **Live docs:** https://alchemy.run
- **Docs styling:** `website/src/styles/custom.css` — the ground truth for
  color tokens, spacing, dark-only theme.
- **Hero diagrams:** `website/images/alchemy-effect-*.png` — hand-drawn
  Function → Binding → Resource triple, layers, terminal screenshots.
- **Sibling repos** (same brand): `alchemy-run/alchemy` (core),
  `alchemy-run/distilled` (Effect-native cloud SDKs).

---

## Index

| File / folder         | What's in it                                                                    |
| --------------------- | ------------------------------------------------------------------------------- |
| `README.md`           | This doc — brand context, content & visual foundations, iconography             |
| `SKILL.md`            | Agent Skill manifest (usable standalone in Claude Code)                         |
| `colors_and_type.css` | All design tokens: colors, type, spacing, radii, shadows, motion                |
| `fonts/`              | Local webfont fallbacks (Inter, JetBrains Mono, Caveat via Google Fonts import) |
| `assets/`             | Logos, hand-drawn diagrams, product screenshots                                 |
| `preview/`            | HTML specimen cards — one per token group / component cluster                   |
| `ui_kits/website/`    | Marketing + docs UI kit (hero, feature grid, terminal, provider cards)          |
| `ui_kits/docs/`       | Docs reader UI kit (sidebar nav, article, code blocks, callouts)                |

### Products covered

1. **alchemy.run marketing site** — landing, what-is, getting-started. Astro + Starlight.
2. **alchemy.run docs** — sidebar nav, MDX articles, expressive-code blocks, terminal widget.

No app UI exists — Alchemy is a CLI + library. The CLI's terminal output
(`$ alchemy deploy`, colored plan/apply reports) is itself a visual surface
and is recreated as a component.

---

## Content Fundamentals

Alchemy's voice is **technical, calm, and quietly opinionated**. It talks to
senior TypeScript engineers. It never hypes, never uses exclamation marks for
emphasis, and never uses emoji outside the occasional Discord context.

**Tone rules**

- **Lowercase brand name** always: _alchemy_ — not "Alchemy" in body copy
  (headings can capitalize for sentence case; the wordmark itself is always
  lowercase).
- **Short declarative sentences.** Max ~18 words. Break into paragraphs
  instead of running on.
- **"You" for the reader, "we" for the team.** "Come hang in our Discord."
  "You'll install Alchemy and Effect."
- **Technical terms are the nouns.** Capitalize product concepts when used
  as proper nouns: _Stack_, _Resource_, _Provider_, _Binding_, _Layer_,
  _Output Attribute_. Leave verbs lowercase: _deploy_, _bind_, _yield_.
- **Code is a first-class citizen.** Almost every paragraph either
  introduces a code block or refers to `monospace identifiers`. Don't
  paraphrase what the code shows — show it.
- **No hype adjectives.** Never say "amazing", "powerful", "revolutionary",
  "magical". Say what it does.
- **Specific numbers > vague claims.** "in under two minutes", "Node.js 22+",
  "under 30 minutes" — concrete, verifiable.
- **Em-dashes (—) for rhetorical pivots**; used frequently. Same character,
  no spaces around it sometimes, with spaces sometimes — match the docs.
- **Tagline form:** "**X.** Y." — two sentences, first is the category, second
  is the value. _"Infrastructure-as-Effects. Your infrastructure and
  application logic in a single, type-safe program."_

**Casing**

- Product name in prose: **alchemy** (lowercase)
- Headings: **Sentence case** — "Getting started", "What is alchemy?",
  "Plan, deploy, destroy"
- `alchemy deploy`, `alchemy dev`, `alchemy destroy` — CLI verbs lowercase
- TypeScript identifiers verbatim (`Cloudflare.R2Bucket`, `Effect.gen`)

**Don't**

- ❌ Emoji in marketing / docs body copy
- ❌ Rhetorical questions as headings ("Why Alchemy?")
- ❌ Marketing filler ("we're excited to announce…")
- ❌ Capitalizing "Alchemy" mid-sentence
- ❌ Introducing a concept without a code example nearby

**Representative copy**

> _"Infrastructure as **Effects**. Your infrastructure and application logic in
> a single, type-safe program."_
>
> _"If it compiles, it deploys."_
>
> _"Resources are just Effects. Resources are declared as Effects and
> composed with `yield_`. Import them from any file, bind them to Workers,
> pass their outputs to other resources — it's all just TypeScript."\*
>
> _"Preview what will change with `plan`, apply it with `deploy`, and tear
> it down with `destroy`. Stages isolate environments so `dev` and `prod`
> never collide."_
>
> _"alchemy is in alpha and not ready for production use (expect breaking
> changes). Come hang in our Discord to participate in the early stages of
> development."_

---

## Visual Foundations

### Mode

**Dark mode only.** The `color-scheme: dark` declaration is hard-coded and
the theme toggle is hidden. Every surface is on a near-black canvas. Do
not produce light-mode variants unless explicitly asked — they don't exist.

### Color

- **One accent:** `#00e599` — a bright, slightly-yellow mint green. Used for
  emphasis, success states, CTAs, link hovers, the wordmark dot, and the
  single gradient stop in "Infrastructure as **Effects**" hero text.
- **Canvas:** `#0a0a0a` (page) → `#111111` (nav/sidebar) → `#18181b` (elevated
  cards) → `#1f1f23` (hover). Steps are ~1–2 lightness units apart — very
  subtle.
- **Neutrals:** Tailwind Zinc scale (50 → 950). Body text at zinc-200/300,
  muted at zinc-400, captions at zinc-500.
- **Hairlines:** `rgba(255,255,255,0.06)` for default borders, `0.10` for
  hover/emphasis. No solid-gray borders.
- **Semantic colors in terminal output:**
  - Success / create: `#00e599` (same mint)
  - Update: `#f5a524` (amber)
  - Replace / destroy: `#f04b4b` (red)
  - Info / tag: `#7cc5ff` (cyan)
  - Dim: `#71717a`

**No purple. No blue gradients. No "SaaS violet".** The only gradient in the
entire brand is `linear-gradient(90deg, #fff, #00e599)` applied as
`background-clip: text` on the word "Effects" in the hero.

### Type

- **Inter** (400/500/600/700/800) — UI, headings, body
- **JetBrains Mono** (400/500/600) — all code, terminal output, eyebrows
- **Caveat** (600) — hand-drawn diagram labels (see Iconography)
- Letter-spacing: `-0.04em` on display, `-0.02em` on headings, `0` on body.
- Headings are **sentence case**, weight 700, tightly tracked. No all-caps
  except monospace eyebrows (`EYEBROW TEXT`, 12px, `letter-spacing: 0.1em`).

### Spacing

- 4px grid: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96.
- Section rhythm on marketing pages: `margin-bottom: 5rem` (80px) between
  hero / features / providers / CTA.
- Max content width on landing: `72rem` (1152px).

### Backgrounds

- **Flat solid black-ish surfaces** — no patterns, no noise, no gradients.
- **Hand-drawn sketch illustrations** are the signature decorative element —
  they appear as standalone hero artwork, not backgrounds. See Iconography.
- Occasional full-bleed terminal screenshots demonstrating CLI output.

### Borders & cards

- Border radius: **8px** standard (provider cards, buttons, code blocks),
  **4–6px** for small chips/tags, **12px** for large hero panels.
- Cards: `background: #18181b; border: 1px solid rgba(255,255,255,0.06);
border-radius: 8px; padding: 1.5rem;`
- **Never** a colored left-border accent. Never an "alert callout" stripe.
- Hover on a card: border becomes `var(--alc-accent)`. That's it — no
  transform, no shadow change, no scale.

### Shadows

- Near-zero by default. Dark surfaces don't need elevation shadows.
- When used: `0 4px 14px rgba(0,0,0,0.5)` for floating elements.
- **Accent glow** is allowed sparingly on focused/active CTA buttons:
  `0 0 0 1px rgba(0,229,153,.4), 0 0 24px -4px rgba(0,229,153,.4)`.

### Transparency & blur

- Transparency is used for **hairlines** (`rgba(255,255,255,.06–.16)`) and
  **accent washes** (`color-mix(in srgb, #00e599 12%, transparent)`).
- No frosted-glass / backdrop-blur surfaces. Alchemy's surfaces are crisp
  and opaque.

### Motion

- **Restrained.** Marketing page has essentially no animation. Hover
  transitions are `120–180ms ease` on color/border only.
- Easing: `cubic-bezier(0.2, 0, 0, 1)` — standard Material out-curve.
- No bounces, no parallax, no auto-playing hero videos.
- Prefer instant state changes for developers — they move fast and dislike
  jank.

### Hover states

- **Links:** color → `var(--alc-accent)`.
- **Cards with a link:** border-color → `var(--alc-accent)`. No translate.
- **Primary buttons:** background slightly brighter, no transform.
- **Secondary buttons / icon buttons:** background → `rgba(255,255,255,.04)`.

### Press / active states

- Buttons darken a touch (`filter: brightness(0.95)`) — no scale-down, no
  inset shadow. The goal is "it registered" without bouncing.

### Focus states

- **2px mint outline, 2px offset.** Never remove focus rings.
  `outline: 2px solid #00e599; outline-offset: 2px;`

### Layout rules

- Fixed top nav (64px tall, `#111` bg, hairline bottom border).
- Docs: 260px left sidebar (`#111`), article body max-width 768–820px,
  optional right-side "On this page" column.
- Marketing: centered, 72rem max-width, generous 5rem between sections.

### Imagery vibe

- **Hand-drawn, warm, slightly-silly sketches** on otherwise austere dark
  surfaces. Black ink on white paper, dropped into the dark theme as-is
  (white backgrounds show through — it's a deliberate contrast).
- Product screenshots (VS Code, terminal) appear in their native
  github-dark-dimmed theme. Preserve as PNGs.
- No stock photography. No AI-generated imagery. No people.

### Code blocks

- **Theme:** `github-dark-dimmed` (Expressive Code). Keyword `#f47067`, string
  `#96d0ff`, function `#dcbdfb`, type `#6cb6ff`, comment `#768390`.
- **Filename header:** small mono label at top-left, dim.
- **Diff additions:** green `+` prefix with row tint; deletions: red `-`
  prefix with row tint. TwoSlash-powered.

---

## Iconography

**Alchemy does not use an icon font or lucide/heroicons in its marketing
or docs.** The visual vocabulary splits into three categories:

### 1. Hand-drawn sketch illustrations (signature)

Black-ink marker sketches on white, scanned and dropped into the dark
theme. Used for explaining concepts on the README and marketing site. They
replace what would normally be iconographic diagrams.

Available in `assets/`:

- `diagram-triple.png` — **Function → Binding → Resource** (the core triple)
- `diagram-triad.png` — triad diagram
- `diagram-layers.png` — Effect Layer hierarchy sketch
- `screenshot-plan-type.png` — VS Code type-hover screenshot
- `screenshot-output.png` — VS Code stack output screenshot
- `screenshot-policy-error.png` — VS Code IAM policy type error

**Typography in sketches:** labels look like Caveat / marker handwriting.
When recreating digitally, use **Caveat 600** as the nearest Google Fonts
match. Flag to the user that true sketches should be produced by hand or
with an illustrator.

### 2. Code as decoration

The biggest "icons" on the marketing site are **code blocks themselves**.
Every feature card has a syntax-highlighted TypeScript snippet paired with
a short paragraph. Treat code blocks as the primary visual unit — size
them, pad them, give them room.

### 3. CLI glyphs (terminal component)

Inside the custom `<Terminal />` component, plain unicode / ASCII glyphs
signal status:

- `✓` success (mint)
- `+` create (mint)
- `~` update (amber)
- `-` / `×` destroy (red)
- `◉` / `○` radio selection
- `•` bullet / separator (dim)
- `[u]…[/u]` underline markup, `[b]…[/b]` bold, `[d]…[/d]` dim, `[g]…[/g]`
  green/success, `[c]…[/c]` cyan

### 4. Small UI icons (Starlight built-ins)

The docs layout uses Starlight's stock icons — `right-arrow`, `open-book`,
`github`, `bun`, `npm`, `pnpm`, `seti:yarn` — for link buttons and tabs.
When recreating, **use Lucide** (CDN) as the closest stroke-weight match,
or the original Starlight icons if available. Flag this substitution.

### 5. Logo mark

`assets/logo-mark.svg` — a mint dot on a rounded black square. This is a
**placeholder** synthesized from the wordmark style on the live site; the
repo does not contain an official logo file. **Ask the user for a real
logo asset.**

Emoji usage: **none** in marketing/docs. Fine in community spaces
(Discord) but out of scope for the design system.
