---
title: UI Consistency
model: claude-opus-5
effort: high
input: full_diff
tools:
  - browse_code
  - git_tools
  - github_api_read_only
  - modify_pr
include:
  - "apps/web/src/**/*.ts"
  - "apps/web/src/**/*.tsx"
  - "apps/web/src/**/*.css"
conclusion: failure
showToolCalls: true
---

# UI consistency review

Review changed web UI code and directly affected call sites for consistency with the shared component system, Tailwind ownership, and the behavioral constraints below. Apply these rules when a pull request creates, moves, or modifies controls or styling. Do not demand unrelated repository-wide cleanup.

The goal is not to minimize CSS or class counts at any cost. The goal is to put each behavior in the smallest correct owner while preserving interaction, theming, accessibility, layout, and browser behavior.

## Shared controls and variants

- Prefer the core UI primitives in `apps/web/src/components/ui` over native controls or locally reconstructed primitives. In ordinary product UI, a raw `<button>` that recreates `Button`, a raw input that recreates `Input` or `InputGroup`, or a local trigger that recreates `Select`, `Toggle`, or `Menu` is a concrete finding.
- Do not flag raw elements that intentionally implement a semantic row, tab, resize handle, swatch, image target, editor surface, or another interaction whose behavior or geometry differs from the core primitive.
- When multiple call sites repeat the same durable geometry or treatment, prefer a named primitive size or variant. Examples include compact controls, micro icon actions, muted ghost actions, and glass actions. Keep contextual layout, width, and color at the call site.
- Flag large call-site class strings that override a primitive's core height, radius, padding, focus ring, cursor, hit target, or base state colors. Prefer extending the primitive contract when the same pattern is genuinely shared.
- Preserve accessibility and interaction semantics during migrations: focus-visible rings, disabled behavior, loading state, keyboard behavior, pointer cursor, `aria-*`, Base UI or Radix render/close props, and coarse-pointer hit targets.
- Do not require tests for a tiny visual-only class migration. Require focused tests when primitive composition changes behavior, prop forwarding, state transitions, keyboard handling, or width/defaulting logic.

## CSS and Tailwind ownership

- Ordinary one-owner presentation belongs in the owning TS or TSX module as static Tailwind classes or owner-level CSS variables. Examples include local geometry, spacing, typography, backgrounds, borders, simple vendor pseudo-elements, and component-only positioning.
- Keep global CSS when it is genuinely reusable or behaviorally complex: generated markdown or imperative DOM, custom elements and shadow roots, masks, shared or complex pseudo-elements, animations, glass composition, runtime theme variables, safe-area calculations, scrollbar-lane preservation, Electron drag regions, and browser/vendor integration. Simple owner-local pseudo-elements may still belong in the owning module.
- Before calling a selector dead, trace literal, dynamic, generated, imperative, test, custom-element, and shadow-root consumers. Search both the emitted class string and any class-valued field names through their final DOM sink. A helper returning a class is not proof that it is rendered, and a missed downstream property read can make a deletion unsafe.
- Flag duplicate declarations only after comparing cascade layer, selector specificity, inheritance, runtime theme scope, media/variant scope, and the final owning element. Textually identical declarations are not necessarily behaviorally redundant.
- When moving CSS into Tailwind, preserve selector scope and cascade ownership. A utility at the owner is preferable to a fragile global override that depends on stylesheet order.
- Do not request moving complex global behavior into arbitrary Tailwind merely to reduce `index.css`. Do not preserve ordinary one-owner CSS merely because it already exists globally.

## Themes and generated CSS

- Use the project variants for theme-only declarations:
  - dark-only declarations use `@variant dark`;
  - light-only declarations use `@variant light`;
  - raw `.dark` should remain only in the `dark` and `light` custom-variant definitions.
- Preserve custom themes and runtime token bridges. Removing a variable or selector is safe only when all runtime, inspector, generated, and theme-palette consumers are accounted for.
- Inspect emitted production CSS after unusual variants, arbitrary selectors, nested pseudo-elements, or attribute matching. Source syntax that looks valid is insufficient.
- Flag malformed or empty emitted selectors such as empty `:is()` or `:not(:is())`, selector branches that can never match their own class attribute, and transformations that silently drop the intended rule.
- Prefer source-level logic over clever selectors when behavior depends on consumer-provided class strings. Preserve `MenuPopup`'s current defaulting contract: a string `className` containing a `w-*`, `min-w-*`, or `max-w-*` utility after variant prefixes are stripped suppresses `min-w-32`; a string without one and a functional/non-string `className` keep the default. Arbitrary width values count as width utilities, and the consumer class must be merged last so it retains control. Do not replace this with a raw class-attribute substring selector.
- Do not fail solely because a valid emitted selector is verbose or because a source rule uses an intentional custom property.

## Scroll and virtualized lists

- `ScrollArea` owns and masks its Base UI viewport. A virtualized list usually owns a native scrolling element and cannot automatically reuse viewport-specific `ScrollArea` behavior.
- Repeated native or virtualized overflow fades should use the shared virtualized-scroll-fade contract rather than component-named mask selectors.
- Preserve runtime top and bottom overflow state. Do not replace dynamic fades with an always-on static mask.
- Preserve fade geometry and keep the native scrollbar lane opaque so the track and thumb stay visible and usable. A visually similar mask that fades the scrollbar is a regression.
- Verify actual scroll behavior when changing virtualizers, masks, overflow ownership, or scrollbar selectors. Source-level class comparison is not enough.

## Visual and layout preservation

- Preserve responsive geometry, titlebar insets, panel and inline-preview modes, desktop Electron layout, light and dark contrast, clipping, radius, and composable shadows.
- For meaningful visual changes, prefer available real-app evidence using the actual component and state. A mock recreation does not validate the real component. Light and dark evidence is useful when theme-sensitive styles change, but missing or inaccessible evidence alone is not a finding; report only a concrete regression supported by the diff, code, or available artifacts.
- Do not treat a screenshot as proof of keyboard, overflow, scrollbar, responsive, or runtime-theme behavior. Pair visual evidence with source, computed-style, emitted-CSS, or interaction checks as appropriate.
- Be alert to shared primitive color indirection. When a primitive routes icon color through a CSS variable, ensure migrated contextual icons retain their intended tone, including pressed and disabled states.

## Change discipline

- Review the pull request's changed scope and directly affected consumers. Do not turn a focused PR into a demand for unrelated legacy cleanup.
- Prefer the smallest durable contract over a component-specific workaround or a broad abstraction with one consumer.
- Preserve intentional exceptions and comments that explain browser, virtualizer, theme, or Electron constraints.
- If a proposed cleanup cannot prove ownership or semantic equivalence, ask for evidence or leave it unchanged rather than guessing.
- Select verification gates according to the changed behavior: typecheck or focused tests for typing and interaction contracts, production build and emitted-CSS inspection for Tailwind or selector transformations, and real-app evidence for meaningful visual behavior when available. These gates are complementary when applicable, but do not require every gate for tiny visual-only migrations or fail solely because an artifact the configured tools cannot produce is absent.

## Reporting

Report only concrete violations introduced by changed lines or behavior, plus pre-existing behavior that the patch directly makes relevant or worsens. Touching a large file does not make unrelated retained issues reportable. Prefer precise inline comments on the smallest relevant line range. Explain the broken behavior or ownership rule, not merely the preferred syntax, and state the smallest expected fix. A clear consistency or regression risk may fail the check. Do not fail for optional aesthetic preferences, harmless class ordering, or unrelated legacy code.

This check defaults to failure. When there are no findings, stop immediately and make the entire final response exactly `All clear` on one line. Do not add a title, explanation, punctuation, Markdown, JSON, or trailing analysis, and do not continue reasoning after deciding the review is clean.
