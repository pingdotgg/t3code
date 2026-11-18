# Progress (radys-s fork)

## 2026-11-12: Auto model

- What: an "Auto" model with its own Low/Medium/High level. Picking it never reaches a provider; the server replaces it in every command (`OrchestratorV2.dispatch`) with a concrete model chosen from live usage limits: Fable (high), Opus (medium) or Sonnet (low) on whichever Claude account has more room, then Codex, Grok and OpenCode when Claude is out.
- Why: Tomáš wanted one Auto entry in the model picker that routes across all his subscriptions, including Claude A vs B.
- How it shows up: a custom model `auto` (with an `effort` select of low/medium/high) on the Auto Claude instances in settings. No web change was needed; the picker already renders custom models and their options.
- Numbers: resolver 5/5 tests; shared and server typecheck clean (server took 22 min on the first, cold run, ~6 min warm).
- Worked: one wrapper around `dispatch` covers web, mobile, MCP and scheduled tasks. Stickiness keeps a thread on its model until it passes 90% used, so threads do not hop accounts on each message.
- Next: after the first message the composer shows the concrete model, not "Auto"; keeping Auto selected mid-thread needs a client change.

## 2026-11-13 — Auto gets its own icon in the model picker

- What: the `auto` model shows a Route icon in the theme's primary color (picker rows and the composer button) instead of the Claude logo, and drops the account badge, since Auto picks the account itself.
- Why: Tomáš could not tell Auto apart from the concrete Claude models at a glance.
- How: `ProviderInstanceIcon` takes an optional `modelSlug`; `ModelListRow` and `ProviderModelPicker` pass it. Lint rules ruled out Sparkles and raw palette colors.
- Deploy: web-only, so the new `apps/web/dist` was copied into `apps/server/dist/client`; no service restart. The web build took ~45 min on the hub (disk-bound).
- Next: keep "Auto" shown in the composer after the first message (needs the thread to remember the Auto selection).

## 2026-11-13 — Auto shows the model it routes to

- What: the `auto` entry keeps the logo of the provider it routes to (the Claude logo while Claude has room) with a small route badge, and its label names the model and account, e.g. "Auto · Opus 5.5 (B)", in the picker rows and on the composer button.
- Why: Tomáš wanted to see which Claude model Auto uses; the plain route icon hid it.
- How: `describeAutoRoute` (web) runs the server's `resolveAutoModelSelection` on the client's provider snapshots, at the composer's Auto level, on a minute clock. The server still decides per message (a thread may stay on its current model until 90% used).
- Tests: `autoRoute.test.ts` (2 tests: A/B pick per level, fallback to Grok). The test run alone took ~14 min on the hub.

## 2026-11-13: Auto routes by 5-hour use and weekly reset; Auto levels as picker rows; subscriptions overview

- What: Auto now picks between Claude accounts by the freer 5-hour window; when two accounts are within 10 points, it spends the one whose weekly quota resets first (unused quota is lost at reset). Antigravity's Claude models (Opus 4.6 Thinking, Sonnet 4.6) sit right after the Claude subscriptions in every level. `auto-low` / `auto-medium` / `auto-high` fix the level in the model slug, so the Auto tab in the picker lists one row per level, each naming its current route. Usage → Limits opens with a Subscriptions table: one row per account with every window's remaining % and reset.
- Why: Tomáš wants Auto to always use Claude A/B first and route by 5-hour room and weekly expiry, use the Antigravity subscription too, show its levels like other models, and see each subscription next to the pooled view.
- Numbers: autoModel tests 9/9 (3 new routing cases failed before the change, plus a level-slug test). Web typecheck clean in 47 s warm.
- What worked: the Limits page showed Claude and distinct A/B numbers once the hub was quiet. The missing Claude section and copied numbers came from limit probes timing out while the hub was overloaded (load 11, IO pressure ~90).
- Next: one combined web + server build, deployed with a stop/start of t3code.service, then settings switch the Auto tab to the three level rows.

## 2026-11-13: Agents commit each step with its origin

- What: `AGENTS.md` gets a Commits section. Agents commit and push each finished, checked step of medium size or larger, one idea per commit, with a body that says why and where the change came from (issue, PR, review finding, thread link, or the request). PRs merge with a merge commit so those steps stay in `main`. The PR template repeats the rule in one line. Outside the repo, `~/.agents/T3-CODE.md` and the `auto` and `swarm` skills got the same rule.
- Why: Tomáš wants to trace a problem back to the step and request that caused it. One big commit per task, or a squash merge, hides that.
- Numbers: docs only, 4 commits in PR #4. The fork runs no CI checks on PRs.
- Next: watch whether agents keep the cadence. If they do not, add the rule to the built-in orchestration instructions (`orchestrationInstructions.ts`, needs evals).

## 2026-11-13: Auto staggers Claude A/B 5-hour windows

- What: Auto now keeps sending work to the account whose 5-hour window is already running, until any of its windows reaches 90%, then moves to the other account. Within 10 points of 5-hour use, the sooner weekly reset wins. Past 90% everywhere, the account with the most left wins.
- Why: preferring the emptier account started both 5-hour windows at the same time, so both ran out together. Staggered windows let one refresh while the other is in use.
- Numbers: 11 routing tests (3 new), a mutation check (dropping the 90% rule fails 3 tests).
- Next: watch real routing on the hub for a day of use.

## 2026-11-13: Auto levels on every machine

- What: every Claude provider on a fork server lists Auto Low, Medium and High as built-in models, so Auto needs no settings. The model picker pins the three levels at the top of Favorites, from the first Claude instance that lists them, until the user stars an Auto level themselves.
- Why: Tomáš wants Auto in every thread, including threads that run on his PC's own T3 server, which has none of the hub's settings.
- Numbers: 1 new server test, 3 new picker tests; server and web typecheck clean (6 min and 62 s on the hub).
- Next: Tomáš builds the fork desktop app on his PC; Auto there routes only to the providers logged in on that PC.

## 2026-11-14: Auto routes to the Auto instances again; fork synced with upstream for hub2

- What: Auto prefers instances named "Auto…" (the ones launched with `auto-mode.md`) when accounts tie. The fork merged upstream main (653 commits, no conflicts) and runs on hub2 from `~/projects/t3code-auto`.
- Why: since every Claude provider lists the Auto levels (#6), the old "lists an Auto model" check matched every Claude instance. Plain `claudeAgent` shares account A's usage with `claudeAuto` and comes first in the registry, so Auto sent turns to it and the orchestrator never got the routing prompt. hub2 ran upstream nightly (DB schema 89); the fork stopped at 85, so it could not run there.
- Numbers: autoModel 12/12 (the same-account case failed before the fix), ClaudeProvider + ProviderRegistry 80/80, web Auto tests 7/7; typecheck of contracts, shared, server and web clean (21 s server on hub2). Fork build 59 s on hub2.
- Next: link hub and deploy the same branch there; rebuild the desktop app on the PC.

## 2026-11-14: Auto threads stop showing a false "Context handoff pending"

- What: the shared pending-handoff check (web and mobile) resolves an Auto selection the way the server does, keeping the thread's current model while it fits, before deciding a handoff is coming.
- Why: in the real hub2 UI, every Auto thread showed "Context handoff pending: Sonnet 5.5 (AB) → Auto Low (CL)" after each turn, while the server log showed the next message stay on `claudeAutoB` (sticky).
- Numbers: handoff + contextWindow tests 39/39 (the new case failed before); client-runtime, web and mobile typecheck clean. Deployed on hub2 as a web-only build (51 s), no restart.
- Next: link hub and run the same checks there; rebuild the PC desktop app.

## 2026-11-14: Threads routed by Auto stay on Auto

- What: the model Auto picks carries an `auto` option with its level. The server treats it as Auto on the next command (sticky while under 90%), and web and mobile show the thread's composer as "Auto Low · now Sonnet 5.5 (B)" instead of "Sonnet 5.5 Low".
- Why: Tomáš saw "Sonnet 5.5 Low" in a thread started on Auto Low. The server stored only the concrete model, so Auto showed only where a local draft remembered it, and clients without the fork's composer sent the concrete model, ending Auto for that thread.
- Numbers: autoModel 12/12, handoff + contextWindow 39/39 (a recursion the stamp caused was caught by the handoff test); shared, client-runtime, web, mobile and server typecheck clean. Checked in a clean incognito browser on a scratch copy of hub2's data: a thread started on Auto Low over the CLI shows Auto Low in the composer.
- Deploy: service now runs from `~/.t3/fork-current` (a symlink to the deploy checkout), so a new build goes into a fresh checkout and the restart flips the link.
- Next: hub (link it first) and a fork build of the PC desktop app; the stock app still shows the concrete model.

## 2026-11-14: Auto fails over to the next subscription the moment one hits its limit

- What: `AutoFailoverService` watches failed runs. When a run on an Auto thread fails with a usage limit (`usage_limit` class: Claude 429 / 5-hour / weekly, Codex `usageLimitExceeded`, Antigravity `RESOURCE_EXHAUSTED`) or no capacity (`UNAVAILABLE`, Claude 529), it benches that provider instance (`AutoCooldown`, until the reported reset, else 30 min; 5 min for no capacity) and sends the thread back through Auto with "Continue where you left off". Auto routing (`resolveAutoModelSelection`) skips benched instances, the sticky current one included. At most 6 failovers per thread per hour.
- Why: Auto routed only when a message was sent. A limit hit mid-work left the thread failed, and the upstream recovery worker resumed it on the same account hours later, at reset. Tomáš wants Auto to chain across all subscriptions as soon as one runs out. The PC's own DB showed 28 failed runs in two days, most of them limit errors (429, quota, capacity) that should have moved on.
- Numbers: autoModel 13/13 (new blocked case), AutoFailoverService 6/6; server typecheck clean.
- Limits: the bench is in memory, so a server restart forgets it (the usage report takes over). A failure whose session error differs from the run's error item has no error class and is not failed over.
- Next: build the PC desktop app from `tomas/pc-nightly`; deploy to hub/hub2.

## 2026-11-15: Auto failover review fixes, and a way back to the better model

- What: (1) Auto's sticky rule now gives way when a better candidate for the level has room again. Before, a thread that failed over to a weaker model (say Grok) stayed there for good while that account was under 90% used, even after Claude reset. (2) Failover follows the `autoResumeLimitedThreads` setting: off means the failed instance is still benched (the next message the user sends routes around it), but T3 sends nothing on its own. (3) Failover skips a provider's own subagent threads, which cannot receive messages.
- Why: review of `d25e0609c7` before it went on the PC. The failover sends turns by itself, so a mistake there spends every subscription. The one-way downgrade contradicted the Auto skill, which says a provider re-enters the chain when its window resets.
- Checked and left alone: the domain event stream starts at the latest sequence, so a server restart does not replay old failed runs into failovers. A failover and the upstream reset-resume cannot both fire: the resume needs the thread's latest run to be the failed one. The return to a better model needs that account under 90%, so a thread does not hop back onto an account about to run out.
- Numbers: autoModel 14/14, AutoFailoverService 7/7, server typecheck 0 errors.
- Cost: moving back up is one more provider handoff (a thread summary). It happens once per reset, on the next message.
- Next: build the PC desktop app from `tomas/pc-nightly` and install it.

## 2026-11-15: Resume works on every provider; limited hand-picked threads move to Auto

- What happened (PC, thread "Port Hub T3 App Improvements to PC"): Claude hit its 5-hour limit. The thread was not on Auto (it started on the Auto instance before Auto existed, with a plain Opus model), so no failover ran. The composer was switched to Grok and Resume pressed. Grok has no native resume, so each Resume failed at once with "Native resume is unavailable". The one "continue" that reached Grok ran a few tool calls, then hit Grok's free limit, which T3 cannot see in usage windows. Every later "continue" went to Grok again and failed. Result: about ten turns with no answer.
- Fix 1 (`ProviderTurnStartService`): Resume on a provider without native resume now starts an ordinary turn with "Continue where you left off." (plus the handoff context when the provider changed) instead of failing. Upstream's test "refuses unsupported resume" was rewritten to the new behavior.
- Fix 2 (`AutoFailoverService`): a thread not on Auto that hits a usage limit now fails over through Auto at the level its model implies (Fable/Sol/Astra high; Sonnet/Haiku/Flash/OpenCode/Luna low; else medium). Delegated threads not on Auto are left alone: their parent chose the model.
- Setup repo: `fallbackModelSelection` (Grok) is cleared by `apply-auto-settings.py`; the health check warns while it is set.
- Numbers: AutoFailoverService 8/8; ProviderTurnStartService 65/69, the same 4 failures as before the change (Windows-only git/startup tests); server typecheck 0 errors.

## 2026-11-18: Fork synced onto upstream `373ec12be6`

- What: the 18 fork commits from `1f698f01d9..bd33ae897c` were rebased onto upstream main `373ec12be6` (300 upstream commits newer). `origin/main` is recorded as an ancestor with an `-s ours` merge, as in the previous sync, so the PR merges without a force-push.
- Why: the fork was 300 commits behind upstream two days after the last sync.
- Conflicts: 3 sites in 2 files, all from upstream translating the whole app (#37893): `ProviderModelPicker.tsx` (fork's Auto trigger label vs upstream's `gt()` labels) and `UsageLimitsPooled.tsx` (imports moved to `usageLimitsCopy.ts`). Kept upstream's translated strings and the fork's Auto and pooled-view behavior.
- Adapted to upstream: reset advice (`suggestResetCredit`) moved from `usageLimits.ts` to `usageLimitsCopy.ts`, where upstream now keeps `formatDuration` and other client copy. The fork's pooled view, chart, reset advice and Subscriptions heading wrap their copy in `<T>`/`gt()` (upstream's `no-untranslated-copy` lint), and the web catalogs gained those 17 keys.
- Numbers: `vp run check:changed` all pass (typecheck 42 packages, 492 tests in 25 files, lint, knip, format, react compiler); `vp run i18n:check` pass; `UsageLimitsPooled.browser.test.tsx` 2/2.
- Real run (worktree `.t3`, seeded copy, never `~/.t3/userdata`): Auto High/Medium/Low pinned at the top of Favorites with their routes, Usage → Limits pooled view and reset advice render, one Claude Haiku turn answered. Production build (`apps/web vp run build`, `apps/server node scripts/cli.ts build`) boots on an empty data dir.
- Next: Tomáš switches hub2 and hub to the new build.
