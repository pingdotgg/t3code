---
title: UI Consistency
model: claude-opus-5
effort: medium
input: full_diff
tools:
  - browse_code
  - modify_pr
include:
  - "apps/web/src/**/*.tsx"
  - "apps/web/src/**/*.css"
exclude:
  - "apps/web/src/**/*.test.tsx"
labels:
  - vouch:trusted
requires:
  - Check
maxBudgetPerPR: 25
conclusion: failure
maxBudgetPerRun: 10
---

# UI consistency review

This is a styling guard for `apps/web`, not a general review. Review only the changed lines in the diff and answer three questions. Do not build the project, inspect emitted CSS, trace selector consumers across the codebase, or ask for screenshots. If the diff does not make a violation obvious, there is no finding.

## 1. Shared primitives over custom controls

Product UI must use the primitives in `apps/web/src/components/ui` (`Button`, `Input`, `InputGroup`, `Select`, `Toggle`, `Menu`, `Dialog`, `Tooltip`, `ScrollArea`, and the rest of that directory) instead of rebuilding them.

- Flag a raw `<button>`, `<input>`, `<select>`, or `<textarea>` styled to look like a control when the matching primitive exists.
- Flag a call site that overrides a primitive's height, radius, padding, focus ring, or base colors with its own class string. If the same look is needed in several places, the fix is a new size or variant on the primitive.
- Do not flag raw elements that are intentionally not a primitive: semantic rows, tabs, resize handles, swatches, editor surfaces, or anything whose behavior or geometry is different by design.

## 2. Tailwind in the owning component, not global CSS

Styling lives as Tailwind classes in the component that renders the element.

- Flag new rules added to `apps/web/src/index.css` or any other `.css` file when the same styling could be Tailwind classes on the owning component. New global CSS is acceptable only for things Tailwind cannot express at the owner: generated markdown or imperative DOM, custom elements and shadow roots, animations, runtime theme variables, and browser or Electron integration.
- Flag new `style={{ ... }}` objects or inline `<style>` blocks that carry static values a Tailwind class already covers. Dynamic values computed at runtime are fine.
- Flag theme-only declarations that use raw `.dark` selectors instead of `@variant dark` / `@variant light`.

## 3. Composable components

The reference for how this codebase wants UI built is the composer banner system in `apps/web/src/components/chat/`:

- `ComposerBanner.tsx` exports one object of small slot components (`Root`, `Row`, `Icon`, `Content`, `Actions`, `Dismiss`, `Children`, and so on). Each slot owns its own Tailwind classes, exposes a `data-slot` attribute, takes `className` and spreads the rest of its props, and uses `cn` so callers can adjust without overriding. Variants and density are props on `Root`, not ad hoc class strings at call sites. Where a slot needs a real control it renders `Button` from `ui/` rather than a styled `<button>`.
- `ComposerBannerStack.tsx` composes those slots into the ordered stack and owns only stack behavior (priority, expand and collapse, dismiss transitions).
- Consumers such as `ComposerActivityStatus.tsx`, `ComposerStashBadge.tsx`, and `ComposerPlanFollowUpBanner.tsx` are a few lines of `<ComposerBanner.Row><ComposerBanner.Icon/><ComposerBanner.Content>…` with no styling of their own.

Hold new and changed UI to that shape:

- Flag a new component that copies a chunk of an existing primitive's markup and classes instead of composing or extending it.
- Flag a large one-off class string on a shared component when it is clearly the same treatment another call site already uses. The fix is a variant or a new slot on the shared component.
- Flag a new composer banner or notice that bypasses `ComposerBanner` slots and hand-builds its row, icon column, or actions.

## Reporting

Report only violations introduced by changed lines. Post each as a brief inline comment on the relevant line: name the rule, name the primitive or location the code should use instead, and stop. Do not comment on class ordering, aesthetic preference, or untouched legacy code, and do not demand cleanup outside the PR's scope.

When there are no findings, make the entire final response exactly `All clear` on one line with nothing else.
