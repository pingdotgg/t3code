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

## 2026-11-18: Auto High runs Opus 5.5 at Extra High, not Fable

- What: `AUTO_CANDIDATES.high` now starts with `claude-opus-5-5` at the `xhigh` effort level ("Extra High", one step above High), and Fable 5.2 is gone from the high chain. The Antigravity Opus, Codex Sol/Astra/Luna, Grok and Gemini fallbacks keep their `high` effort. `impliedAutoLevel` (the failover path for hand-picked threads) no longer reads Fable as a high model, since Fable now only sits in the medium chain.
- Why: Tomáš's Claude accounts have no Fable access yet, so Auto High routed to a model that was never usable there and fell through to Opus at plain High. He asked for Auto High to mean Opus at a higher effort.
- Numbers: autoModel 14/14, AutoFailoverService 8/8, claudeModelOptions 7/7. Effort levels the catalog offers for Opus 5.5: low, medium, high, xhigh, max, ultracode, ultrathink; `max` is one step above `xhigh` if he wants the ceiling.
- Next: ship on the PC fork build, then hub and hub2.

## 2026-11-18: Fork synced onto upstream `373ec12be6`

- What: the 18 fork commits from `1f698f01d9..bd33ae897c` were rebased onto upstream main `373ec12be6` (300 upstream commits newer). #10 (Auto High on Opus at Extra High), merged to fork main during the sync, comes in through a normal merge. `origin/main` is recorded as an ancestor with an `-s ours` merge, as in the previous sync, so the PR merges without a force-push.
- Why: the fork was 300 commits behind upstream two days after the last sync.
- Conflicts: 3 sites in 2 files, all from upstream translating the whole app (#37893): `ProviderModelPicker.tsx` (fork's Auto trigger label vs upstream's `gt()` labels) and `UsageLimitsPooled.tsx` (imports moved to `usageLimitsCopy.ts`). Kept upstream's translated strings and the fork's Auto and pooled-view behavior.
- Adapted to upstream: reset advice (`suggestResetCredit`) moved from `usageLimits.ts` to `usageLimitsCopy.ts`, where upstream now keeps `formatDuration` and other client copy. The fork's pooled view, chart, reset advice and Subscriptions heading wrap their copy in `<T>`/`gt()` (upstream's `no-untranslated-copy` lint), and the web catalogs gained those 17 keys.
- Numbers: `vp run check:changed` all pass (typecheck 42 packages, 492 tests in 25 files, lint, knip, format, react compiler); `vp run i18n:check` pass; `UsageLimitsPooled.browser.test.tsx` 2/2.
- Real run (worktree `.t3`, seeded copy, never `~/.t3/userdata`): Auto High/Medium/Low pinned at the top of Favorites with their routes, Usage → Limits pooled view and reset advice render, one Claude Haiku turn answered. Production build (`apps/web vp run build`, `apps/server node scripts/cli.ts build`) boots on an empty data dir.
- Next: Tomáš switches hub2 and hub to the new build.

## 2026-11-18: Auto-routed Claude turns see their level in the system prompt

- What: when Auto routed a Claude turn, the system prompt ends with one line, `Auto level: <low|medium|high>`, taken from the `auto` option the router stamps on the selection. Hand-picked models get nothing new. The level is part of the compiled Claude selection, so a level change on a live session (say Auto Medium → Auto High, where only the effort moves on the same Opus 5.5) is no longer applied live: the next turn reopens the process with resume, as a thinking change already does. A level change while a background shell runs is refused the same way.
- Why: since #10, Auto High runs Opus 5.5 at Extra High. `~/.agents/auto-mode.md` told the orchestrator to read its level from its model name (Opus → medium), so every Auto High thread routed itself as medium and could not see the level Auto picked.
- Providers: Claude only. Only the Claude Auto instances (`claudeAuto`, `claudeAutoB`) carry `auto-mode.md`; Codex, Grok, OpenCode and Antigravity have no Auto orchestrator prompt to correct.
- Numbers: the new adapter test failed on base (live effort change, no reopen) and passes; ClaudeAdapterV2 + claudeModelOptions 475/475. Real run on the worktree's seeded `.t3`: one Auto Low thread over the CLI (Sonnet 5.5 at low, Auto's first Low candidate) quoted `Auto level: low` from its system prompt.
- `~/.agents`: `auto-mode.md` and the `auto` skill read the level from that line and fall back to the model name only without it.
- Next: deploy on hub2 and the PC; copy the `~/.agents` change into `radys-s/t3-setup-improvements` for hub.

## 2026-11-19: Auto ranks accounts by weekly pace

- What: among accounts with room, Auto now goes first to the one with the higher weekly pace: weekly % left divided by the hours until that weekly window resets, the burn rate that spends the quota exactly at its reset. Paces within 15% of each other tie, and then the old order decides (the further along 5-hour window, so windows still stagger, then the sooner weekly reset). An account without weekly data ranks after accounts that have it; a weekly window that reports no reset has not started, so it counts as a full window from now (a fresh week, about 0.6%/h). A one-model weekly window counts only for its model: the per-window check moved out of `exhaustedUsageWindow` into `usageWindowLimitsModel`, which Auto's pace reuses and which now reads Claude's `seven_day_<model>` windows the way the server's hub pool check already did, so a spent Fable-only allowance no longer blocks Opus on that account. Unchanged: Auto-aware instances first, the 90% guard, the sticky rule and the return to a better model.
- Why: Tomáš asked Auto to "focus mainly on the weekly limit, by how depleted it is". The weekly quota is the scarce one: what is left at the weekly reset is lost, and an account that runs dry early blocks a whole day. On 2026-11-19 07:15 CET Claude A had 32% left for 52.8 h (0.61%/h) and Claude B 60% for 149.8 h (0.40%/h), and the 5-hour stagger, not the weekly state, chose between them.
- Numbers: autoModel 17/17 (the 2026-11-19 example, the no-weekly-data case, the unstarted-window case and the one-model-window case failed on base), usageLimits 99/99 (the new Claude row failed on base), AutoFailoverService 8/8, handoff 17/17, codexUsageLimits 20/20, autoRoute 2/2 (it already failed on fork main: it still expected Fable for Auto High). `vp run check:changed`: format, lint, knip, typecheck (36 packages) and 120 tests in 4 files pass. Real run on the worktree's seeded `.t3` with the two Auto instances: Usage → Limits showed A at 27% weekly left for 2d 2h (0.54%/h) and B at 60% for 6d 3h (0.41%/h), and the picker named A for every level (Auto High · Opus 5.5 (A)). The old rule also picks A right now (A's 5-hour window 39% used, B's 1%), so this run shows the wiring, and the unit tests cover where the rules differ.
- `~/.agents`: the `auto` skill drops "Never move work between Claude A and Claude B because of limits" and says Auto picks the account by weekly pace.
- Next: backlog 2 (model-aware room) can build `hasRoom` on `usageWindowLimitsModel`; today a one-model window at 90% still marks the whole account as out of room. Deploy on Tomáš's word.

## 2026-11-19: Fork synced onto upstream `aced664ed9`

- What: the 28 fork commits since the last sync were cherry-picked onto upstream main `aced664ed9` (175 upstream commits newer, 699 files changed): the 20 commits of the 2026-11-18 sync (its 18 replayed fork commits, its i18n catalog commit and its progress entry; first parent of `373ec12be6..1eafff1cc9^2`), then #10, #12, #13 and #15. Fork main also holds the pre-sync originals of older fork commits (they come in through the second parents of #9 and #11); those were left out, so nothing is applied twice. The fork main that was replayed (`1a2d9afd88`) is recorded as an ancestor with an `-s ours` merge, as in the last two syncs, so the PR merges without a force-push. #14 (fork CI on GitHub-hosted runners), merged to fork main during the sync, comes in through a normal merge: it only changes `ci.yml` and `mobile-fingerprint-check.yml`, which upstream did not touch.
- Why: the fork was 175 commits behind upstream a day after the last sync.
- Conflicts: 2. `Orchestrator.ts` imports: upstream's `assistantCitations` import next to the fork's `autoModel` and `ProviderRegistry` imports; kept both. `docs/progress.md` on #10: took fork main's text as of #11, which had resolved the same conflict. The other 22 files both sides changed merged cleanly.
- Adapted to upstream: upstream's Resume fix (#38847) added `RESUME_PROMPT` to `ProviderTurnStartService.ts` with the same text as the fork's `MANUAL_RESUME_CONTINUE_TEXT`; the fork's Resume on providers without native resume now sends upstream's constant. The two paths never meet: the fork's forces `resume: false`. Nothing else needed changes: for each file, the lines the fork adds and removes are the same on the new base as on the old one, and apart from that swap `git diff origin/main HEAD` holds exactly upstream's changes. `OrchestratorV2Shape` did not change upstream, so Auto routing still wraps every command.
- Upstream change that touches Auto: a steer the agent never read is now sent again once its run ends (`requeueUnreadSteers`), on that run's model and without Auto routing. If the run failed on a usage limit, the steer waits for that account like any message queued before the failure, and failover still moves the thread: the queue holds runs for a limited instance, and the thread keeps the failed run as its latest. Before the sync such a steer was never sent.
- Numbers: `vp run check:changed` (56 files since upstream/main, #14 included) all pass: typecheck 42 packages, 986 tests in 27 files, lint, knip, format, react compiler. `vp run i18n:check` pass. Focused: autoModel 17/17, usageLimits 99/99, AutoFailoverService 8/8, ProviderTurnStartService 88/88; with the 3 Orchestrator test files, ClaudeAdapterV2 and ProviderRegistry, 809/809 in 9 files.
- Real run (worktree `.t3`, seeded from a read-only copy of the live database, settings with only the two Auto instances): Auto High · Opus 5.5 (B), Auto Medium · Opus 5.5 (B) and Auto Low · Sonnet 5.5 (B) pinned at the top of Favorites. Usage → Limits showed the Subscriptions table (A: 9% of the 5-hour window left, 21% weekly; B: 81% and 57%) and the pooled Claude view with its reset advice. B is the route because A's 5-hour window is past the 90% guard. One Claude Haiku 5.5 turn answered "OK".
- Review: one read-only review of the resolutions found no bugs. Taken: the `RESUME_PROMPT` swap. Checked and set aside: the claim that a re-sent steer starts on the limited account and stops failover (`usageLimitHoldsQueue` keeps it queued; upstream's "keeps queued user selections and pauses only the limited provider" test pins that).
- Next: Tomáš merges the PR, then switches hub2 and hub to the new build. Open, not part of the sync: queued messages and re-sent steers stay on the account that failed instead of following an Auto failover, and the fork's 17 Usage keys are still English in the 9 non-English web catalogs (since the 2026-11-18 sync).

## 2026-11-19: Auto room check counts only windows that limit the model

- What: `hasRoom` and `peakUsedPercent` in Auto routing (`autoModel.ts`) are now model-aware: they only consider active windows that limit the candidate model, determined via `usageWindowLimitsModel`, and ignore expired windows whose reset time has passed. Claude's extra-usage spend window (`monthly_spend`) limits no model when the account has plan windows (`usageWindowLimitsModel`, like Codex's credit cap), so it neither counts for room nor blocks the account at 100% (`exhaustedUsageWindow` was wrong there too). Unknown usage (no report, no window that limits the model, or no session window) no longer masquerades as 0% used: accounts with unknown usage rank after accounts with known room and before accounts past 90%, do not pull sticky threads back via `betterHasRoom`, and an account without a session window ranks after one with a known session.
- Why: Auto previously computed `peakUsedPercent` across all windows of an instance regardless of model, so a model-specific window (e.g. Claude's `seven_day_<model>` for Fable at 90%, or Antigravity's Gemini session pool at 90%, or Claude's extra-usage spend at 90%) marked the entire account full for all models including Opus. Furthermore, missing usage data read as 0% empty, making unprobed instances look fresh, win "most left" tie-breaks, and incorrectly steal sticky threads through `betterHasRoom`.
- Numbers: autoModel 24/24 tests pass (8 new tests failed on base covering model-specific windows, Antigravity pools, monthly spend, expired windows, unknown usage ranking, missing session window, sticky retention, and past-90% ordering). `vp run check:changed` passes clean: format, lint, knip 1/2 and 2/2, typecheck (36 packages), 26 tests in 2 files.
- What worked: real run on dev server seeded from read-only live data (`.t3/userdata`), where Auto Low cleanly dispatched and answered "Auto (low)\n\nOK" on Claude Sonnet 5.5.
- Review: own review plus a read-only review on the second Claude account. Fixed, each with a failing assertion first: `monthly_spend` counted again once plan windows passed 90%, and at 100% it blocked an account whose plan had room. Removed dead code: the contract requires `usedPercent`, and Grok's missing percentage is a real 0%, so "a window without `usedPercent`" cannot happen; the tests now use reachable unknown cases. Reverted an unrequested change that dropped expired weekly windows from the pace. Open: providers that never report a window for the model (OpenCode free models, no-usage providers) are always unknown, so a thread that fell back below them never returns through `betterHasRoom`; and an account whose windows have all reset reads as unknown until the next probe.
- Next: Tomáš merges the PR, then switches the hubs to the new build.
