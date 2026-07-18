# PATCH.md

This file records the intent behind deliberate customizations made by a
downstream T3 Code fork. Code and Git commits are the implementation; this file
explains what must survive an upstream update.

## Upstream

- Repository: `https://github.com/pingdotgg/t3code`
- Branch: `main`

## Verification

Commands that must pass after a customization or upstream update:

- Check: `vp check`
- Typecheck: `vp run typecheck`
- Native mobile changes: `vp run lint:mobile`

Bootstrap dependencies with `pnpm install --frozen-lockfile` when the checkout
is not already installed. This setup step is not a verification result.

## Active customizations

No downstream customizations are recorded in the upstream repository. Fork
maintainers should copy the entry below for each deliberate customization.

<!--
### customization-id

- **Status:** active
- **Intent:** What outcome should this customization provide?
- **Why:** Why does this fork need behavior that upstream does not provide?
- **Behavior:** What observable requirements must remain true?
- **Scope:** Which files, packages, or subsystems are involved?
- **Reconstruction:** How should a future developer or agent rebuild the intent
  on newer upstream code? Include constraints, not a full code patch.
- **Retire when:** Optional for temporary fixes. What observable check proves
  upstream now satisfies this intent?
- **References:** Optional commits, issues, or upstream pull requests.
-->

## Retired customizations

Move or copy retired entries here, set `Status` to `retired`, and explain why
the customization is no longer needed. Do not delete its history.
