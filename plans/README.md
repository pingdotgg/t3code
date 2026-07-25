# Animation Improvement Plans

Written by the `improve-animations` skill. Plans 001–005 were authored at commit `774d2f560` (2026-07-15); plans 006–011 at commit `c9013c976` (2026-07-25) from a full re-audit of `apps/mac` (chat timeline, composer, shell/sidebar, diff). Each plan is self-contained: an executor needs no context beyond the plan file.

| #   | Plan                                                                                                     | App    | Severity | Status         |
| --- | -------------------------------------------------------------------------------------------------------- | ------ | -------- | -------------- |
| 001 | [Animate press feedback in the two custom ButtonStyles](001-mac-press-feedback-buttonstyles.md)          | mac    | MEDIUM   | DONE (via 011) |
| 002 | [Symmetric exits for working pill + pending cards](002-mobile-symmetric-exits-thread-pills.md)           | mobile | MEDIUM   | TODO           |
| 003 | [Animate ErrorBanner mount/unmount](003-mobile-errorbanner-enter-exit.md)                                | mobile | MEDIUM   | TODO           |
| 004 | [PR/merge success gets the delight tier](004-mac-vcs-success-delight.md)                                 | mac    | LOW      | DONE (via 011) |
| 005 | [Smooth the determinate LoadingStrip](005-mobile-loadingstrip-determinate-smoothing.md)                  | mobile | LOW      | TODO           |
| 006 | [Let user-initiated timeline disclosures animate mid-run](006-mac-timeline-disclosure-animation.md)      | mac    | HIGH     | DONE           |
| 007 | [Tool-row lifecycle beats and chat card polish](007-mac-chat-lifecycle-beats.md)                         | mac    | MEDIUM   | DONE           |
| 008 | [Composer seams: segmented control, hover intent, popover crossfades](008-mac-composer-seams.md)         | mac    | MEDIUM   | DONE           |
| 009 | [Sidebar & shell polish: disclosure curves, hover washes, status eases](009-mac-sidebar-shell-polish.md) | mac    | MEDIUM   | DONE           |
| 010 | [Diff surfaces: pane swaps, file-switch crossfade, row hover](010-mac-diff-surfaces.md)                  | mac    | MEDIUM   | DONE           |
| 011 | [Press feedback scale + VCS success delight](011-mac-press-and-vcs-delight.md)                           | mac    | MEDIUM   | DONE           |
| 012 | [Residual chat polish: settle cue, live text crossfades, hover parity](012-mac-chat-residual-polish.md)  | mac    | LOW      | DONE           |

Plans 006–012 all landed in one PR. Rebase reconciliation onto `c0e157d37` (main after #221–#229): plan 008's context-meter step was dropped as a duplicate of #229's shipped `scheduleDetails` debounce; plan 010's mode-swap and row-extraction steps were made obsolete by #221's unified-feed restructure of `ChangesTimelineView` (main already animates checkpoint expansion on `Motion.structure` and file-row hover on `Motion.feedback`); plan 007's double-entrance fix was extended to `PlanCard`, which #226 had restructured with `.entrance(.card)`.

## Recommended execution order

006 → 007 → 008 → 009 → 010 → 011 (leverage order: the mid-run disclosure fix first — it is the user-facing complaint — then per-surface polish). Mobile plans 002 → 003 → 005 remain independent and can run any time.

## Dependencies

All plans are behaviorally independent. File-level conflicts to respect when parallelizing:

- 006 and 007 both edit `apps/mac/Sources/SergeCodeMac/UI/Chat/ChatTimelineRow.swift` (different regions: disclosure toggles vs ripple/badge/timestamp/preview-sheet) — execute together or sequentially, never as two parallel agents.
- 011 edits `apps/mac/Sources/SergeCodeMac/UI/Shell/VcsToolbar.swift` and `apps/mac/Sources/SergeCodeMac/UI/Chat/ChatFollowUpBar.swift`; 009 edits other shell files — no overlap.
- 008 (composer), 009 (sidebar/shell), 010 (diff) touch disjoint file sets and parallelize freely.

## Verification commands

- mac: `swift build --package-path apps/mac`; feel checks via the verify flow in `apps/mac/.claude/skills/verify/SKILL.md` (mock backend + UIProbe).
- mobile: `pnpm --dir apps/mobile typecheck`; feel checks on simulator/device with iOS Reduce Motion toggled both ways.
- All plans, in addition to the per-app checks above: `vp check` and `vp run typecheck` must pass before work is considered complete (repository-wide requirement, `AGENTS.md`).
