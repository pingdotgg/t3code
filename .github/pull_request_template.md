<!--
PR policy reminders (delete this comment before submitting):
- Target SergeSerb2/SergeCode only. NEVER open PRs against pingdotgg/t3code.
- Keep the PR focused on one change; keep the diff minimal and reviewable.
- Merging to main only ships a release when this PR carries the `release` label.
  Do not touch apps/mac/version.json unless a new version was explicitly requested.
-->

## Summary

<!-- What changed and why. Link related issues. -->

## Area

<!-- Check all that apply. -->

- [ ] `apps/mac` — native macOS app
- [ ] `apps/mobile` — iPhone companion app
- [ ] `apps/server` — backend server
- [ ] Shared packages (`packages/contracts`, `packages/shared`, `packages/client-runtime`, …) or relay (`infra/relay`)
- [ ] Build, CI, or release tooling
- [ ] Docs

## Verification

<!-- How was this tested? Check what you actually ran and note the results. -->

- [ ] `vp check` passes
- [ ] `vp run typecheck` passes
- [ ] `vp run lint:mobile` passes (required for native mobile changes)
- [ ] Manually verified (describe below)

## Screenshots / Recordings

<!-- Required for user-facing UI changes on macOS or mobile. Delete if not applicable. -->

## Release notes

<!-- One line describing the user-facing impact, or "None" for internal changes. -->
