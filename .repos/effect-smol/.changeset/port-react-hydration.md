---
"effect": patch
"@effect/atom-react": patch
---

Port ReactHydration to effect-smol.

Add `Hydration` module to `effect/unstable/reactivity` with `dehydrate`, `hydrate`, and `toValues` for SSR state serialization. Add `HydrationBoundary` React component to `@effect/atom-react` with two-phase hydration (new atoms in render, existing atoms after commit).
