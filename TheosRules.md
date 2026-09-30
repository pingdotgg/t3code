# Theo's rules

Review guidance distilled from Theo's maintainer discussions and related PRs. Apply it to the relevant surface and context; current maintainer direction, AGENTS.md, CONTRIBUTING.md, and the release runbook govern specific decisions.

## Product and interface

### 1. The interface should not move in ways the user doesn't expect

No animation, transition, layout shift, or reflow unless the user asked for it or can predict it. Content the user is reading or targeting must not jump out from under them. If something must move, the user should be able to see why it moved.

### 2. Taste rules are enforced before merge, not after

Address taste regressions before merge. Record recurring constraints so future reviews can apply them consistently.

### 3. Remove redundant status that adds no useful information

Status already conveyed elsewhere should earn any extra space it takes, especially above the composer. Remove duplication that adds height without helping the user.

### 4. Prioritize composer regressions

Fix composer regressions promptly. Revert a change when that is the fastest way to restore the experience, even if the feature itself is desirable; polish elsewhere can wait.

### 5. Minimize churn for the majority of users

Prefer changes that leave most users' experience untouched. When something has to come back out, revert it promptly, so users see "nothing changed," not two competing designs in a row.

### 6. No objectively worse experiences

Every behavior and default needs a reason that survives the question "why does this make sense at all?" If only one option makes sense, ship that one instead of a menu of them.

### 7. Onboarding must answer "what's next?"

Users get stuck on empty states no matter how obvious the button seems. Every first-run path needs a clear next action.

## Defaults and settings

### 8. Agree on changes to established defaults before merge

Defaults are part of the product. Get explicit maintainer agreement before changing behavior users already rely on. An unexpected default change calls for a process investigation as well as a fix.

### 9. Every setting must earn its place

Each config option creates an ongoing maintenance commitment, so new ones require team agreement before merge. Default to not adding it.

### 10. Make each setting's scope explicit

Keep track of where settings live: client-specific, global, or server-specific. Make ownership and inheritance clear, including supported project overrides; ambiguity about scope is the problem.

## Scope and features

### 11. Keep thread import from becoming a sync commitment

For threads imported from other tools, favor smooth onboarding over an ongoing promise of sync, auto-import, and migration support. Consider the follow-up support commitment when choosing scope.

### 12. Tighten the triage bar during a release freeze

During a declared stable-release freeze, defer noncritical work and focus on getting the release out. The 10-line / 1,000-report threshold came from a specific freeze, not a standing bar for bug fixes.

### 13. Performance on large threads is the bar

Benchmark against "hell threads" (hundreds of messages, long sessions). Large-thread responsiveness is an important bar; it does not replace checking other affected workloads and platforms.

### 14. Never ship a default that isn't viable

Evaluate default models on the task they will perform and their usage cost. For title and text generation, prefer the user's existing harness over a dedicated model that performs poorly or exhausts usage. This is not a blanket fallback policy for every provider or mode.

### 15. Enforce cross-surface parity with machines, not heroics

Where clients cannot share contract types directly, use generated bindings or CI parity checks to catch drift. Swift API parity should not depend solely on agents manually porting every change.

### 16. Reconsider integrations that keep fighting you

When an integration keeps failing, evaluate a simpler, more reliable flow with the team. The Electron authentication discussion favored considering a redirect flow; time spent debugging alone is not a reason to remove every troublesome dependency.

### 17. Keep Apple Silicon downloads straightforward

Do not send Apple Silicon users an Intel build or complicate their download to accommodate Intel Macs. An explicitly labeled Intel download may take extra steps. This decision concerns Mac distribution, not a blanket rule for every minority platform.

## Releases and process

### 18. Honor declared release freezes

When maintainers declare a freeze, only critical bug fixes merge during that window. A freeze is not required for every stable release: the release workflow can promote a verified nightly while main continues advancing.

### 19. Scope creep is why releases never ship

"Just one more thing" is the enemy of shipping. Land it after the release.

### 20. Dogfood the nightly before cutting stable

Heavily dogfood the exact nightly, conclude there are no meaningful regressions, then ship. Merge → think it's fine → ship stable → hit bugs is how bad releases happen.

### 21. Promote the verified nightly for normal stable releases

The normal manual stable release builds the latest published nightly's commit, not whatever is on `main` at release time. Follow the [release runbook](docs/operations/release.md) for explicit-tag releases, including release-branch fixes.

### 22. Leave substantial review work out of the release candidate

Do not rush a large or heavily debated PR into a stable cut just because the feature is wanted. Leave time to review and verify it for a later release.

### 23. Build automated nets for regressions

"Hard to test" starts the conversation; it doesn't end it. When a class of regression escapes, add the check that catches it on future PRs.

### 24. When damage reaches users, investigate the process

A bad merge means several layers failed: why it was made, why it was put up, why it merged. Fix the layers; merge access follows demonstrated reliability.

### 25. Stay out of an area someone is actively landing

Do not build on or rework a surface someone has open PRs against. Coordinate first; otherwise the work collides and one of the two gets thrown away.

### 26. The rules apply to Theo too

Whoever sets the rules follows them visibly, including skipping the PR they most want in the release.

### 27. The founder's bugs need not come first

Theo has explicitly put another reporter's bugs ahead of his own. The founder's status does not automatically give his reports priority.
