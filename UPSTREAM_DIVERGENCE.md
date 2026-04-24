# Upstream Divergence Log

Tracks how MarCode's `main` relates to upstream `pingdotgg/t3code:main`. Its job is to prevent every sync cycle from re-deriving the same answers to:

1. Which upstream commits have we already ported? (under possibly-different SHAs)
2. Which upstream commits are we intentionally **not** porting? (and why)
3. Which upstream commits are genuinely still pending?

Complements [`FEATURES.md`](./FEATURES.md) — that one protects MarCode-exclusive features during merges. This one protects the merge _ledger_ itself.

> Sister file: [`FEATURES.md`](./FEATURES.md) lists the features we **add** and must not lose.

---

## How to use this doc

When starting a new upstream sync:

```bash
git fetch upstream
# Strict "no patch-equivalent" set — includes ported-under-different-SHA
git cherry origin/main upstream/main | grep "^+ " | awk '{print $2}' > /tmp/raw_missing.txt

# Subtract the "already-equivalent" set below — those have different SHAs by design
# Subtract the "intentionally-skipped" set below — those we're never porting
# What remains is real work
```

Sections are ordered by action:

1. [Ported in the current cycle](#ported-in-the-current-cycle) — new SHAs on `main`
2. [Already equivalent under a different SHA](#already-equivalent-under-a-different-sha) — do **not** re-port
3. [Intentionally skipped](#intentionally-skipped) — do **not** port
4. [Pending real work](#pending-real-work) — what's actually left

---

## Ported in the current cycle

**Cycle:** 2026-04-24 · Baseline before cycle: `7c430aece` · Baseline after cycle: `9f6411d17`

### Direct-to-main (no PR, user-approved)

| Upstream                                               | Subject                                                          | New SHA     |
| ------------------------------------------------------ | ---------------------------------------------------------------- | ----------- |
| [#1198](https://github.com/pingdotgg/t3code/pull/1198) | fix(web): prevent composer controls overlap on narrow windows    | `f6fc7071f` |
| [#2224](https://github.com/pingdotgg/t3code/pull/2224) | fix: Change right panel sheet to be below title bar / action bar | `ec46a66a2` |
| [#1934](https://github.com/pingdotgg/t3code/pull/1934) | chore(desktop): separate dev AppUserModelID on Windows           | `0740d14d5` |
| [#1951](https://github.com/pingdotgg/t3code/pull/1951) | fix(web): allow concurrent browser tests to retry ports          | `569891444` |
| [#2095](https://github.com/pingdotgg/t3code/pull/2095) | \[codex\] Fix Windows release manifest publishing                | `9e3091d3a` |
| [#2100](https://github.com/pingdotgg/t3code/pull/2100) | ci(release): install deps before finalize version bump           | `1a179b852` |

### PR #66 — low-risk t3code fixes

| Upstream                                               | Subject                                                  | New SHA     |
| ------------------------------------------------------ | -------------------------------------------------------- | ----------- |
| [#1651](https://github.com/pingdotgg/t3code/pull/1651) | Add IntelliJ project icon to favicon paths               | `1fe62b7ef` |
| [#1975](https://github.com/pingdotgg/t3code/pull/1975) | docs: Document environment prep before local development | `19c4c50c5` |
| [#2152](https://github.com/pingdotgg/t3code/pull/2152) | fix(server): detect localized Windows command errors     | `dd7ddce10` |
| [#2292](https://github.com/pingdotgg/t3code/pull/2292) | Fix Claude session cwd resume drift                      | `4a621a587` |
| [#2301](https://github.com/pingdotgg/t3code/pull/2301) | fix(web): ignore stale runtime projection snapshots      | `5d2f1604d` |
| [#2311](https://github.com/pingdotgg/t3code/pull/2311) | fix(request-permission): add `dynamic_tool_call`         | `7dd31b6cb` |
| [#2313](https://github.com/pingdotgg/t3code/pull/2313) | Exclude subscribe RPCs from latency tracking             | `af5012a92` |

**Conflict resolutions applied:**

- `ChatView.tsx` — kept `@marcode/shared/git` + upstream `useMediaQuery` / `RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY` imports side-by-side.
- `main.ts` (desktop) — applied upstream's dev/prod `APP_USER_MODEL_ID` split to MarCode's namespace: `com.marcode.marcode.dev` / `com.marcode.marcode`.
- `release-smoke.ts` — kept upstream's `assertExists` / `assertMissing` helpers, kept `marcode-release-smoke-` tempdir prefix.
- `ProviderService.ts` (#2292) — dropped the upstream `analytics.record("provider.session.started", …)` call; MarCode has no analytics (see [FEATURES.md §"Telemetry Removal"](./FEATURES.md#telemetry-removal)).
- `ProviderService.test.ts` — swapped `AnalyticsService.layerTest` → `AnalyticsServiceNoopLive` (MarCode exposes only a noop).
- `ProviderCommandReactor.test.ts` ("restarts the provider session when the thread workspace changes") — replaced the hardcoded `/tmp/provider-project-worktree` with a real `mkdtempSync` dir, because MarCode's `ProviderCommandReactor.ts:302` auto-archives threads with missing worktree paths (MarCode behavior: [#54e6ddc2](https://github.com/tyulyukov/marcode/commit/54e6ddc2) "Handle missing worktree directories gracefully"). Without a real dir the session restart short-circuits to auto-archive and the test times out.

### PR #67 — toast close buttons

| Upstream                                               | Subject                     | New SHA     |
| ------------------------------------------------------ | --------------------------- | ----------- |
| [#2023](https://github.com/pingdotgg/t3code/pull/2023) | Add close buttons to toasts | `bb5d51097` |

**Conflict resolutions applied:**

- `toast.tsx` — took upstream's version wholesale (492 → 719 lines). Upstream already bundled `CopyErrorButton` at line 93, so no manual re-integration needed.
- `Sidebar.tsx` — preserved MarCode's "Delete anyway" warning toast flow (action button → deferred close → `api.dialogs.confirm` with thread-count messaging → `removeProject({ force: true })` → inline error toast). Wrapped all toast calls via the new `stackedThreadToast(...)` helper for layout consistency.

---

## Already equivalent under a different SHA

These upstream PRs are **behaviorally present** in MarCode via non-identical patches. `git cherry` flags them as missing because patch-ids differ. **Do not re-port.**

| Upstream                                               | Subject                                                                | MarCode equivalent                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1541](https://github.com/pingdotgg/t3code/pull/1541) | fix(claude): emit plan events for TodoWrite during input streaming     | `f4719a05f feat(tool-activity): TodoWrite → plan sidebar + apply_patch → file-change for Cursor/OpenCode` — generalized via `@marcode/shared/toolActivity` with `isTodoWriteTool` + `extractPlanStepsFromTodos` re-exported in `ClaudeAdapter.ts:48` and also used in Cursor / OpenCode adapters. |
| [#1944](https://github.com/pingdotgg/t3code/pull/1944) | feat(web): add tooltip to composer file mention pill                   | Already present in `ComposerPromptEditor.tsx` from earlier merge. Cherry-pick was an empty diff except for an unrelated `PasteCommandType` import differing.                                                                                                                                      |
| [#1953](https://github.com/pingdotgg/t3code/pull/1953) | Migrate chat scrolling and branch lists to LegendList                  | `f3670b839 perf(chat): restore LegendList virtualization for message timeline` — restored after an earlier merge lost it.                                                                                                                                                                         |
| [#1996](https://github.com/pingdotgg/t3code/pull/1996) | Use latest user message time for thread timestamps                     | **NOT yet equivalent** — listed in [Pending real work](#pending-real-work). Only `917ab971b Remove unnecessary export from getThreadSortTimestamp` exists locally but doesn't carry the substantive behavior.                                                                                     |
| [#2001](https://github.com/pingdotgg/t3code/pull/2001) | Warm sidebar thread detail subscriptions                               | `e82a9cf52 feat(sidebar): restore thread snapshot prewarming` — different implementation (snapshot prewarm in Sidebar), achieves same UX goal. **Per [MEMORY.md]**: do NOT add `retainThreadDetailSubscription` to `ChatView.tsx`.                                                                |
| [#2002](https://github.com/pingdotgg/t3code/pull/2002) | Fix thread timeline autoscroll and simplify branch state               | `fb41df9bd feat(timeline): auto-follow bottom when content grows` — ResizeObserver-based MarCode implementation.                                                                                                                                                                                  |
| [#2024](https://github.com/pingdotgg/t3code/pull/2024) | Add filesystem browse API and command palette project picker           | `b9ef378e9 feat: unify add-project/add-folder on Cmd+K filesystem picker (upstream #2024)` — explicit port.                                                                                                                                                                                       |
| [#2055](https://github.com/pingdotgg/t3code/pull/2055) | feat: configurable project grouping                                    | `6673ca823 feat(sidebar): configurable project grouping (port upstream #2055)` — explicit port + `3dae9e63b chore(web): port path normalization helpers (prereq)`.                                                                                                                                |
| [#2072](https://github.com/pingdotgg/t3code/pull/2072) | feat: add Claude Opus 4.7 to built-in models                           | `788194665` + `4c32418a2` + `18216a500` + `10bdc1225` — full stack including default-effort tweaks.                                                                                                                                                                                               |
| [#2099](https://github.com/pingdotgg/t3code/pull/2099) | guard against missing sidebarProjectGroupingOverrides                  | `c5f4c9115 fix(sidebar): handle undefined sidebarProjectGroupingOverrides on stale settings` — stricter version of the same fix (handles raw JSON decode).                                                                                                                                        |
| [#2153](https://github.com/pingdotgg/t3code/pull/2153) | Redesign model picker with favorites and search                        | `41ddce8f0 feat(model-picker): port upstream sexy redesign with favorites and search` — explicit port.                                                                                                                                                                                            |
| [#2192](https://github.com/pingdotgg/t3code/pull/2192) | fix(server): prevent probeClaudeCapabilities from wasting API requests | Already present: `waitForAbortSignal` + `SDKUserMessage` never-yielding prompt in `ClaudeProvider.ts:485,514`. Cherry-pick diff is empty against our HEAD.                                                                                                                                        |
| [#2255](https://github.com/pingdotgg/t3code/pull/2255) | fix(server): restore CODEX_HOME tilde expansion for Codex launches     | `expandHomePath` already wired on `CodexProvider.ts:226` and `CodexSessionRuntime.ts:688` via [#2210](https://github.com/pingdotgg/t3code/pull/2210) + follow-ups (`63ea04e29`, `42afbb226`).                                                                                                     |

**Verification strategy for re-checking in a later cycle:** grep for the symbol the upstream PR adds. If it's already in MarCode, confirm; do not cherry-pick.

---

## Intentionally skipped

These upstream commits are **never** to be ported unless MarCode's release pipeline adopts the underlying infrastructure. Moving them in creates conflicts without value.

### Blacksmith runners (skipped)

MarCode uses GitHub-hosted runners. Blacksmith adoption would require account setup, billing, and pipeline changes that aren't on the roadmap.

- [#2101](https://github.com/pingdotgg/t3code/pull/2101) `try out blacksmith for releases`
- [#2103](https://github.com/pingdotgg/t3code/pull/2103) `Revert to Github Runner for Windows` — no-op since blacksmith never adopted
- [#2129](https://github.com/pingdotgg/t3code/pull/2129) `Modernize release workflow runners` — the actual migration commit
- [#2146](https://github.com/pingdotgg/t3code/pull/2146) `Guard release workflow jobs from upstream failures` — context depends on blacksmith runners
- [#2147](https://github.com/pingdotgg/t3code/pull/2147) `Guard release workflow jobs on upstream success` — same

### Nightly release channel (skipped)

MarCode ships semver alphas (`1.0.0-alpha.*`), not nightly builds. Adopting nightlies would fragment the update channel.

- [#2012](https://github.com/pingdotgg/t3code/pull/2012) `Nightly release channel`
- [#2025](https://github.com/pingdotgg/t3code/pull/2025) `Fix nightly desktop product name`
- [#2049](https://github.com/pingdotgg/t3code/pull/2049) `Default nightly desktop builds to the nightly update channel`
- [#2134](https://github.com/pingdotgg/t3code/pull/2134) `Throttle nightly release workflow to every 3 hours`
- [#2186](https://github.com/pingdotgg/t3code/pull/2186) `fix(release): use v<semver> tag format for nightly releases`

### Fork-specific release operations (skipped)

- [#2149](https://github.com/pingdotgg/t3code/pull/2149) `Use GitHub App token for release uploads` — requires `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY` secrets configured for the t3tools org, not the fork.
- `2d87574e` `chore(release): prepare v0.0.20` — bumps to upstream's 0.0.x version scheme, collides with MarCode's `1.0.0-alpha.*`.
- `ada410bc` `chore(release): prepare v0.0.21` — same.

---

## Pending real work

| Upstream                                               | Subject                                             | Risk   | Notes                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1996](https://github.com/pingdotgg/t3code/pull/1996) | Use latest user message time for thread timestamps  | Medium | Touches `store.ts` / `storeSelectors.ts` (FEATURES.md §"Incremental Event Handling & Structural Sharing"). 240-line test conflict on `store.test.ts`.                                                                                                                                                                |
| [#2246](https://github.com/pingdotgg/t3code/pull/2246) | Refactor provider model selections to option arrays | High   | Adds migration `026_CanonicalizeModelSelectionOptions`. Touches every `*TextGeneration.ts` (collides with FEATURES.md §"Claude-Powered Text Generation") and collides with MarCode's provider instance registry work (`0e71e3023`, `42b428826`, `4da47be23`). Needs a dedicated branch + regression-guard test runs. |

---

## Merging workflow (lessons from this cycle)

1. **Cherry-pick, don't merge.** A single `git merge upstream/main` produces a wall of conflicts on FEATURES.md-protected files, because MarCode has re-implemented many upstream commits under different SHAs. Cherry-pick individual PRs or small logical groupings into `marcode/port-*` branches.
2. **Use `git cherry-pick -x`.** The `(cherry picked from commit <sha>)` trailer is the fork's audit trail.
3. **Always run `bun run typecheck` + `apps/*/vitest run` locally before pushing.** CI surprises from telemetry-removal leftovers and MarCode-specific behaviors (worktree auto-archive, structural sharing) are common.
4. **Skip-list over port-list.** This doc's `Already equivalent` and `Intentionally skipped` sections save more time on the _next_ cycle than any single port. Keep it honest.
5. **Preserve FEATURES.md exclusives by hand.** Upstream refactors (see PR #67 `Sidebar.tsx` resolution) often simplify flows we deliberately made richer. Re-wire the richer flow through any upstream helper rather than reverting to the simpler variant.
