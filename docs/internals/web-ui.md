# Web UI

## Primitives

Controls come from [`components/ui`](../../apps/web/src/components/ui).
[AGENTS.md](../../AGENTS.md#taste) says how to use and extend them.

Don't style a raw `<button>`, `<input>`, `<select>`, or `<textarea>` to look like a control a
primitive provides. Raw elements are right when the element isn't that control: semantic rows, tabs,
resize handles, swatches, editor surfaces, anything whose behavior or geometry differs by design.

## Styles

Style with Tailwind classes in the component that renders the element.

- Global CSS, in [`index.css`](../../apps/web/src/index.css) or any other stylesheet, is only for
  what classes on the owning component can't express: generated Markdown or imperative DOM, custom
  elements and shadow roots, animations, runtime theme variables, and browser or Electron
  integration.
- No `style={{ ... }}` or inline `<style>` for static values a class covers. Values computed at
  runtime are fine.
- Theme-only rules use `@variant dark` and `@variant light`, not `.dark` selectors.

## Composition

The composer banners are the reference.

- [`ComposerBanner.tsx`](../../apps/web/src/components/chat/ComposerBanner.tsx) exports one object
  of small slots. Slots own their classes, take `className`, and spread the rest of their props,
  merging classes with `cn`. Variants and density are props on `Root`. A slot that needs a control
  renders `Button`.
- [`ComposerBannerStack.tsx`](../../apps/web/src/components/chat/ComposerBannerStack.tsx) composes
  the slots and owns only stack behavior: priority, expand and collapse, dismiss transitions.
- Consumers are a few lines of slots, and the slots carry the styling:
  [`ComposerActivityStatus.tsx`](../../apps/web/src/components/chat/ComposerActivityStatus.tsx).

Build new UI the same way. Compose or extend a component instead of copying its markup and classes.
When a call site repeats a treatment another one already uses, make it a variant or a slot on the
shared component. A new composer banner or notice uses the `ComposerBanner` slots.

## Handlers in large components

V8 gives every closure created in one render a single shared scope. A memoized handler keeps
the scope of the render that created it, and that scope holds the other memoized values of that
render. When handlers in one component change at different times, each keeps an older scope that
holds older handlers, and old renders, with their server config and thread data, stay in memory
for as long as the component is mounted. React Compiler's memoized closures do the same.

In large, long-lived components such as `ChatView` and `ChatComposer`, write handlers as plain
functions and wrap them with [`useStableCallback`](../../apps/web/src/hooks/useStableCallback.ts)
only where they leave the component: props, hook dependency arrays, and effect or memo bodies.
Calls inside the component keep the plain function, so work that resumes after an `await` still
acts on the render it started in. A function that a child calls during render, or after an
`await`, comes from a module-level factory memoized on its inputs, so its closure keeps only
those inputs.

## React Compiler

The compiler memoizes a component or hook only when it can prove the code follows React's rules.
Anything it can't prove, such as reading a ref during render or calling `setState` from an effect,
makes it skip the whole function without a build error. Lint reports each skip as a
`react(...)` warning with the note "React Compiler skipped optimizing this component or hook".

Files listed in the React Compiler override in [`vite.config.ts`](../../vite.config.ts) must
compile. There those rules are errors, and `t3code/no-manual-memo` rejects `useMemo` and
`useCallback`, which the compiler makes redundant. `useStableCallback` still marks handlers
that leave a large component, as described above. Add a file to the list once its skips are
fixed, and drop its manual memoization in the same change.
