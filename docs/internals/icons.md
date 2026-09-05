# Icons (web)

Every interface glyph in `apps/web` flows through one module: `~/icons`.

## The one rule

Never import `lucide-react` directly. Import the same names from `~/icons` instead. The barrel is a
pure re-export, so components, props, and tree-shaking are unchanged. A lint rule
(`eslint/no-restricted-imports` in the root `vite.config.ts`) enforces this; the barrel itself,
generator, and identity test inspect Lucide directly under explicit lint exceptions.
`apps/web/src/icons/index.test.ts` proves every generated export is reference-identical to Lucide's.

Centralizing the imports gives icons a seam: swapping or restyling the set becomes a change to one
module instead of a sweep across the app. Dynamic project icons use the adjacent `~/icons/dynamic`
seam so Lucide can still load only the saved icon at runtime.

## Adding an icon

Import the name you want from `~/icons`. If the barrel does not export it yet:

```bash
vp run --filter @t3tools/web icons:generate
vp run --filter @t3tools/web icons:check
```

The generator parses `src` and `test` as TypeScript/TSX, collects static named icon imports, and
rewrites the barrel. It fails when a runtime import does not exist in Lucide. The check command
fails when the committed barrel is stale.

## Scope

Web and desktop (which renders the web bundle). Mobile renders SF Symbols on iOS with a Tabler
fallback map on Android (`apps/mobile/src/components/AppSymbol.tsx`) and does not share this system.
Brand and product logos (`Icons.tsx`, `JetBrainsIcons.tsx`) and the Pierre file-type sprite are
separate because brand marks are not interface glyphs.
