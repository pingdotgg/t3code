# Mobile (apps/mobile)

React Native (Expo) client. Run commands from `apps/mobile`. Logic shared with web lives in
`packages/client-runtime`; the dev/build loop is in the [README](README.md).

## Tests

`vp test run` (the `test` script) runs colocated `<module>.test.ts(x)` files in the Node
environment from the repository-root Vitest config. There is no native runtime, so tests swap
native/Expo modules for fakes. Pick the harness the surrounding tests use: `@effect/vitest` (its
Effect-aware `it`/`expect`, plus `assert`) for Effect-based code, and `vite-plus/test` for `vi`
and plain `describe`/`expect` — many files mix the two. Only the standalone `.mjs` config-plugin
tests under `plugins/` import from `vitest`. The established pattern for mocked tests hoists mock
fns, installs `vi.mock` factories for native/Expo packages, then imports the module under test:

```ts
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("expo-file-system", () => ({
  File: class {
    arrayBuffer = mocks.read;
  },
}));

import { collect } from "./collect"; // import after the mocks
```

The existing `.test.tsx` component tests render with `renderToStaticMarkup` from
`react-dom/server` against a mocked `react-native`; there is no native renderer in this
environment. A local `modules/*` package may keep its own test setup instead (e.g.
`react-dom/client` with DOM shims in t3-markdown-text); follow the module's existing tests.
Prefer testing logic extracted into plain `.ts` modules over full component renders when the
behavior does not need a tree. Tests for a platform variant import the concrete file and mirror
its name (`voiceTranscription.ios.test.ts` tests `voiceTranscription.ios.ts`).

Typecheck with `tsc --noEmit` (the `typecheck` script). JS/TS lint runs from the repo root
(`vp lint`); native Swift/Kotlin lint is `node ../../scripts/mobile-native-static-check.ts`.

## Platform variants

Styling-only divergence uses `Platform.OS` branches over `className` strings. Uniwind
`ios:`/`android:` class variants are unguarded in this repo's Metro pipeline — Android classes
apply on iOS and vice versa — so do not use them until the pipeline is fixed or upgraded and
platform isolation is proved on both devices; #13169 reverted #13161 (`ec28eefa0d0`) for exactly
this and left no variant usages in `src` — do not reintroduce them. Behavior (not styling)
divergence branches on `Platform.OS` at runtime. When the native UI
diverges wholesale, use file variants: Metro resolves `./Name` to `Name.ios.tsx`,
`Name.android.tsx`, or `Name.native.ts` before the extensionless base, which is the fallback.
When the base and the variant share an implementation, put it in `Name.shared.tsx` and re-export
it from the extensionless base (see `src/features/home/AndroidHomeFab.tsx`) so callers never
branch on it.

## Naming

Components and screens are PascalCase files (`HomeScreen.tsx`, route screens end in
`RouteScreen.tsx`); logic modules are kebab-case (`home-list-options.ts`). Hook files are roughly
evenly split between `useCamelCase.ts` and `use-kebab-case.ts`, so match the surrounding
directory. Feature code lives in `src/features/<feature>/`, shared UI in
`src/components`, native glue in `src/native`. Tests and platform variants sit next to their
module.

## Imports

There is no path alias (`@/`) and no `baseUrl`; use relative imports, however deep
(`../../native/StackHeader`). `@t3tools/client-runtime` has no root export, so always import an
explicit subpath (`@t3tools/client-runtime/state/shell`) — a root-repo lint rule enforces this.

## Native `file:` modules

`modules/*` packages are `file:` dependencies that pnpm copies (not links) into its store, and
Metro bundles the copy. After editing a module's TypeScript, run `vp i` at the repository root or
the change stays invisible to a running dev client; Swift/Kotlin compile from this checkout
directly. A JavaScript change in a local module that "has no effect" on device is usually this
missed reinstall (details in `docs/internals/mobile-development.md`).
