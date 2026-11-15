# Exploro brand

These SVGs are the source of truth for Exploro's identity. `vp run icons:export:exploro` renders
them into every desktop, web and favicon file under `../dev`, `../nightly` and `../prod`, and the
web copies in `apps/web/public`. It uses `mark.svg` for production builds, and `mark-dark.svg` for
dev and nightly builds, so they are easy to tell apart from an installed app. It runs on any OS. The
Icon Composer projects (`*/app-icon.icon`) still hold T3 Code's artwork, so don't run
`icons:export` until they are redrawn.

## Name

**Exploro.** Tagline: "Exploratory QA, with evidence." Keep the capital E in prose. T3 Code keeps its
credit in About and in `LICENSE`.

## Logo: Waypoint cursor

The mark is the "o" of Exploro with the agent's pointer entering it, showing an agent driving a
browser.

| File            | Use                                                                |
| --------------- | ------------------------------------------------------------------ |
| `mark.svg`      | App icon and favicon source on light backgrounds                   |
| `mark-dark.svg` | The same mark for dark backgrounds                                 |
| `mark-mono.svg` | One colour (`currentColor`), with no tile. For UI glyphs and print |
| `wordmark.svg`  | The name set in Sora Bold                                          |
| `lockup.svg`    | Mark and wordmark side by side                                     |

Rules:

- The cursor always keeps its gap from the ring. The colour versions draw the gap with a stroke in
  the tile colour. The mono version cuts it with a mask.
- Don't recolour the cursor anything but probe amber (or `currentColor` in mono).
- Leave clear space of at least a quarter of the mark's width around it.
- The wordmark and lockup use live text. Convert the text to outlines before you export them to PNG
  or ICO, so the result doesn't depend on installed fonts.

## Colour

Teal is the brand colour. It sits away from T3 Code's blue (`oklch(0.488 0.217 264)`) and from the
PASS green. Use amber sparingly: only for the cursor and the keyboard focus ring.

| Token         | Hex       | oklch                    | Use                       |
| ------------- | --------- | ------------------------ | ------------------------- |
| Survey teal   | `#00727D` | `oklch(0.50 0.09 205)`   | Primary, light mode       |
| Teal (dark)   | `#33C0C7` | `oklch(0.74 0.115 200)`  | Primary, dark mode        |
| Probe amber   | `#FEA92F` | `oklch(0.80 0.16 70)`    | Cursor, focus ring        |
| Ink           | `#0C1E22` | `oklch(0.22 0.025 215)`  | Text, light mode          |
| Slate         | `#53676C` | `oklch(0.50 0.025 215)`  | Secondary text            |
| Mist          | `#E1EEF0` | `oklch(0.94 0.014 205)`  | Surfaces, rules           |
| Paper         | `#F6FBFC` | `oklch(0.985 0.006 200)` | Background, light mode    |
| Night         | `#061115` | `oklch(0.17 0.018 220)`  | Background, dark mode     |
| Night surface | `#0E1D21` | `oklch(0.22 0.022 218)`  | Raised surface, dark mode |
| Night text    | `#E4EDEE` | `oklch(0.94 0.01 200)`   | Text, dark mode           |

### Verdicts

Each QA verdict has its own colour, and none of them doubles as the brand colour.

| Verdict      | Light     | Dark      |
| ------------ | --------- | --------- |
| PASS         | `#1D7D3E` | `#67D283` |
| FAIL         | `#C22826` | `#F97770` |
| BLOCKED      | `#A75C00` | `#F7AC4D` |
| INCONCLUSIVE | `#794DB6` | `#B897F0` |
| SKIPPED      | `#5F6B74` | `#A0ADB6` |

### Contrast (WCAG 2.1)

Every pair meant for text meets AA, which is 4.5:1.

| Pair                      | Ratio                           |
| ------------------------- | ------------------------------- |
| White on Survey teal      | 5.67:1                          |
| Survey teal on Paper      | 5.43:1                          |
| Night on Teal (dark)      | 8.65:1                          |
| Ink on Probe amber        | 8.93:1                          |
| Ink on Paper              | 16.4:1                          |
| Night text on Night       | 16.1:1                          |
| Slate on Paper            | 5.71:1                          |
| Verdicts, light, on Paper | 4.82–5.67:1 (BLOCKED is lowest) |
| Verdicts, dark, on Night  | 7.19–10.1:1 (FAIL is lowest)    |

## Type

- Display and wordmark: Sora (600–700).
- Body: IBM Plex Sans.
- Code and data: JetBrains Mono.
