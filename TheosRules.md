# Theo's rules

Rules from Theo about how T3 Code should be built. They apply to every surface: web, desktop, and mobile. Captured from PR reviews and the T3 Code dev Discord.

## Product and interface

### 1. The interface should not move in ways the user doesn't expect

No animation, transition, layout shift, or reflow unless the user asked for it or can predict it. Content the user is reading or targeting must not jump out from under them. If something must move, the user should be able to see why it moved.

### 2. Taste rules are enforced before merge, not after

A change that breaks one of these rules gets addressed before it merges, and the rule lands here so it is not relitigated. Regret is not a review process.

### 3. Redundant information is a defect

If the interface says something that is already conveyed elsewhere, it is waste, not reinforcement. Delete it, especially anything that adds height to the composer.

### 4. The composer must never regress

The composer is the most-used surface in the app. A composer regression outranks almost everything else and gets reverted first, even when the change that caused it is good.

### 5. Minimize churn for the majority of users

Prefer changes that leave most users' experience untouched. When something has to come back out, revert it promptly, so users see "nothing changed," not two competing designs in a row.

### 6. No objectively worse experiences

Every behavior and default needs a reason that survives the question "why does this make sense at all?" If only one option makes sense, ship that one instead of a menu of them.

### 7. Onboarding must answer "what's next?"

Users get stuck on empty states no matter how obvious the button seems. Every first-run path needs a clear next action.

## Defaults and settings

### 8. Never change a user's defaults without permission

Defaults are the product. A change that silently alters what users already rely on is the most serious kind of regression, and it calls for a process investigation, not just a revert.

### 9. Every setting must earn its place

Each config option is maintained indefinitely, so new ones require team discussion before merge. Default to not adding it.

### 10. Every setting has exactly one home

Keep a manifest of what the settings are and which tier each lives in: client-specific, global, or server-specific. A setting that plausibly belongs in two places is designed wrong.

## Scope and features

### 11. Don't build features that become support requests

Features that invite follow-up asks (sync, auto-import, migration tooling) are scope traps. Smooth onboarding instead of building the feature the request would grow into.

### 12. The triage bar

A change over ~10 lines of code for an issue reported by fewer than ~1,000 users is not now. Do not spend main-branch time on it.

### 13. Performance on large threads is the bar

Benchmark against "hell threads" (hundreds of messages, long sessions). If it feels fast there, it is fast everywhere.

### 14. Never ship a default that isn't viable

A default model, provider, or mode that is weak, slow, or burns through usage is a confusing regression even when well-intentioned. Operate as though it doesn't exist and fall back to what the user already has.

### 15. Enforce cross-surface parity with machines, not heroics

Contracts changing on the wire must reach every client through pipelines and CI checks that fail loudly, not agents hand-porting changes.

### 16. When a dependency fights you, replace it

If an integration costs days of fighting, the more reliable design wins. Rip it out in favor of the flow you control.

### 17. Never inconvenience the mainstream platform for a legacy minority

ARM Mac users are never made worse off so Intel holdouts have it easier. Legacy support may cost the legacy users effort, never the mainstream ones.

## Releases and process

### 18. Freeze main before a stable release

Only critical bug fixes merge during a freeze window. Reliability of the release outranks everything anyone wants to land.

### 19. Scope creep is why releases never ship

"Just one more thing" is the enemy of shipping. Land it after the release.

### 20. Dogfood the nightly before cutting stable

Heavily dogfood the exact nightly, conclude there are no meaningful regressions, then ship. Merge → think it's fine → ship stable → hit bugs is how bad releases happen.

### 21. Stable only ships code already proven on nightly

Stable builds the nightly that went out, not whatever is on `main` at release time.

### 22. Huge unreviewed PRs don't merge before a release

A PR with a hundred comments and no review is not getting in before a stable cut, no matter how wanted the feature is.

### 23. Build automated nets for regressions

"Hard to test" starts the conversation; it doesn't end it. When a class of regression escapes, add the check that catches it on future PRs.

### 24. When damage reaches users, investigate the process

A bad merge means several layers failed: why it was made, why it was put up, why it merged. Fix the layers; merge access follows demonstrated reliability.

### 25. Stay out of an area someone is actively landing

Do not build on or rework a surface someone has open PRs against. Coordinate first; otherwise the work collides and one of the two gets thrown away.

### 26. The rules apply to Theo too

Whoever sets the rules follows them visibly, including skipping the PR they most want in the release.

### 27. Users' bugs outrank the founder's

Reports from real users get prioritized slightly higher than internal ones, including Theo's own.
