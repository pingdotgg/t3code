# Animation Improvement Plans

Written by the `improve-animations` skill at commit `774d2f560` (2026-07-15), from a `find-animation-opportunities` sweep of `apps/mac` and `apps/mobile`. Each plan is self-contained: an executor needs no context beyond the plan file.

| #   | Plan                                                                                            | App    | Severity | Status |
| --- | ----------------------------------------------------------------------------------------------- | ------ | -------- | ------ |
| 001 | [Animate press feedback in the two custom ButtonStyles](001-mac-press-feedback-buttonstyles.md) | mac    | MEDIUM   | TODO   |
| 002 | [Symmetric exits for working pill + pending cards](002-mobile-symmetric-exits-thread-pills.md)  | mobile | MEDIUM   | TODO   |
| 003 | [Animate ErrorBanner mount/unmount](003-mobile-errorbanner-enter-exit.md)                       | mobile | MEDIUM   | TODO   |
| 004 | [PR/merge success gets the delight tier](004-mac-vcs-success-delight.md)                        | mac    | LOW      | TODO   |
| 005 | [Smooth the determinate LoadingStrip](005-mobile-loadingstrip-determinate-smoothing.md)         | mobile | LOW      | TODO   |

## Recommended execution order

001 → 002 → 003 → 004 → 005 (leverage order: core-loop feedback first, delight polish last).

## Dependencies

All five plans are behaviorally independent — none depends on another's outcome. Most can run in parallel worktrees, but 001 and 004 both edit `apps/mac/Sources/SergeCodeMac/UI/Shell/VcsToolbar.swift` (different functions: `VcsMergePillButtonStyle` vs `outcomeBanner`/animation modifier); execute those two sequentially, or coordinate the merge if parallel.

## Verification commands

- mac: `swift build --package-path apps/mac`; feel checks via the `apps/mac:verify` skill (mock backend + UIProbe).
- mobile: `pnpm --dir apps/mobile typecheck`; feel checks on simulator/device with iOS Reduce Motion toggled both ways.
- All plans, in addition to the per-app checks above: `vp check` and `vp run typecheck` must pass before work is considered complete (repository-wide requirement, `AGENTS.md`).
