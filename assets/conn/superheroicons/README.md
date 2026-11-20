# Superheroicons, 16px solid

Conn's icon set: every icon in the web, desktop and mobile apps. Vendored from
github.com/nckrtl/superheroicons (`consumers/conn/final`, commit 1302cb2); fix
glyphs there, then copy `16/solid/` and `manifest.json` here again.

- `16/solid/<concept>.svg`: one 16×16 glyph per concept, `fill="currentColor"`.
- `24/solid/`: the few 24×24 glyphs Conn draws at 24px or more (the foldable postures).
- `manifest.json`: `lucide` maps each Lucide name Conn imports to a concept;
  `sf` maps each SF Symbol name the mobile app uses to a concept.

After changing these files run `node scripts/generate-conn-icons.ts` and commit
its output. License: `LICENSE` (MIT; Heroicons MIT, Lucide ISC).
