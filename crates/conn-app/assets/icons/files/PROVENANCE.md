# File-type icon provenance

Standalone SVGs for the file-type icons Conn displays in the Files tree, file
tabs, and file chips (`crates/conn-app/src/file_icons.rs`).

## Sources

1. **`@pierre/trees` `1.0.0-beta.6`** (Apache-2.0)
   - Extracted from `getBuiltInSpriteSheet("complete")` in
     `@pierre/trees/dist/builtInIcons.js`.
   - 52 `file-tree-builtin-*.svg` files (every built-in symbol reachable through
     Conn's resolver; `file-tree-builtin-table` is excluded because Conn maps
     all table extensions to `t3-file-icon-spreadsheet`).
   - Preserves each symbol's `viewBox`, `currentColor` fills, opacity layers,
     and gradient definitions (`nextjs`).

2. **Conn `apps/web/src/pierre-icons.ts`** (`T3_FILE_ICON_SPRITE`)
   - 22 `t3-file-icon-*.svg` files:
     - `video`, `diff`, `xml`, `pdf`, `word`, `spreadsheet`, `slides`, `epub`:
       Lucide icons (ISC license).
     - `csharp`, `dart`, `elixir`, `haskell`, `java`, `kotlin`, `lua`, `php`,
       `powershell`, `r`, `scala`, `toml`: Simple Icons (CC0).
     - `agents`, `pnpm`: Conn custom symbols.
   - Preserves each symbol's `viewBox` and hard-coded fixed fills/strokes
     (`#a631be` on `video`, `#f9ad00` + `currentColor` on `pnpm`).
   - CSS `style="fill: light-dark(a, b)"`, `style="stroke: light-dark(a, b)"`,
     and `style="stroke: var(--document-icon-stroke, light-dark(a, b))"` rules
     are normalized to `fill="currentColor"` / `stroke="currentColor"` so
     `usvg`/GPUI rasterizes them cleanly; the exact light/dark color pairs live
     in `crates/conn-app/src/file_icons.rs` (`IconColor`).
