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
