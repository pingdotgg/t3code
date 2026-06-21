# Power Consumption Investigation

## 2026-06-15 21:06 +0100 - Iteration 1: Ignore Git internal filesystem events

Baseline:

- Existing packaged T3 Code 0.0.27 was already reproducing the issue while apparently idle.
- `ps` showed sustained work in packaged child processes: server PID 31846 around 22-30% CPU with one spike to 85.7%, renderer PID 32339 around 13-14% with one spike to 40.2%, and GPU PID 31326 around 13%.
- `sample 31846 5` showed the server active in Node/libuv child process spawning paths.
- Short-process polling caught repeated Git commands (`git diff --numstat`, `git diff --cached --numstat`, `git symbolic-ref refs/remotes/origin/HEAD`, `git remote get-url origin`) from the dev server while VCS status was subscribed, and a packaged-server `git fetch --quiet --no-tags origin` for `/Users/luismiguelsousa/Sites/career-ops`.

Hypothesis:

- The VCS status filesystem watcher was reacting to repository metadata writes under `.git/`, including writes caused by the app's own remote refresh/fetch operations.
- Those internal Git writes do not represent user-visible working tree changes, but they can trigger local status refreshes and downstream Version Control panel refreshes, creating repeated Git subprocess churn while idle.

Fix:

- Added a focused `.git` root guard in `VcsStatusBroadcaster` before the watcher runs `git check-ignore` or refreshes local status.
- Added a unit test confirming `.git/FETCH_HEAD` and `.git/logs/HEAD` are ignored while normal workspace paths still pass through.

Verification:

- Dev server restarted automatically and Playwright reloaded `http://localhost:8636/`.
- Fixed dev server PID 82195 measured around 0.0-2.9% CPU over 30 seconds, usually under 1%, with `sample 82195 5` showing 4331/4352 main-thread samples blocked in `kevent` and only a handful of active stream/log/GC samples.
- Post-fix 12 second git-process polling showed the previous repeated `git diff --numstat`, `git diff --cached --numstat`, `git symbolic-ref`, and `git remote get-url` churn from the dev server disappeared. A later 18 second poll captured only expected low-frequency remote work from the fixed dev instance (`git fetch --quiet --no-tags origin`, `git config --get remote.origin.url`) plus one unrelated plugin `git ls-remote`.
- The already-running packaged app remained hot because it was still the old installed build: server PID 31846 continued to spike between 0-89%, renderer PID 32339 between 5.7-73.1%, and GPU PID 31326 around 12.5-23.0%. This validates the fix in the patched dev instance but not in the old packaged binary.

## 2026-06-15 21:16 +0100 - Iteration 2: Reduce default remote polling cadence

Baseline:

- After iteration 1, the patched dev server was mostly idle, but an 18 second process poll still caught a remote-status refresh from the dev process.
- The VCS status stream defaulted to the user setting `automaticGitFetchInterval`, whose default was 30 seconds. That meant every active VCS status subscription could run background remote Git work twice per minute while the app was otherwise idle.

Hypothesis:

- Thirty-second background remote polling is too aggressive for an overview panel, especially because local working-tree changes already arrive through the filesystem watcher and explicit branch actions fetch immediately.
- A longer default should preserve passive remote freshness while avoiding frequent idle network/Git wakeups.

Fix:

- Changed `DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL` from 30 seconds to 5 minutes.
- Updated the Version Control settings copy to make the distinction explicit: local file changes still update through the workspace watcher, while remote branch status is background-polled.

Verification:

- Restarted the dev instance and loaded it through Playwright at `http://localhost:8636/pair#token=EDJR5E9A93UC`.
- Over a 60 second post-fix CPU sample, patched dev server PID 96204 stayed at 0.0-0.6% CPU, Vite PID 96146 stayed at 0.0%, Playwright Chrome renderer PID 19598 stayed at 0.1-0.5%, and Playwright Chrome GPU PID 19496 stayed at 0.1-0.3%.
- `sample 96204 5` showed 4338/4350 main-thread samples blocked in `kevent`; only two samples were in child-process spawn paths and four in timer paths.
- An 80 second Git-process poll saw no Git subprocess from the patched dev instance. The only Git subprocess observed was `git --git-dir /Users/luismiguelsousa/Sites/career-ops/.git fetch --quiet --no-tags origin` from the old packaged app server PID 31846.

## 2026-06-17 21:07 +0100 - Iteration 3: Discarded ultrathink composer animation hypothesis

Baseline:

- During a live T3 Code desktop session, `ps` and `powermetrics` showed sustained renderer/GPU-side work in the installed app even when the diagnostics screen reported 0% CPU. Representative samples included renderer PID 29728 around 8.9-10.2% CPU and GPU helper PID 28787 around 17.8-18.8% CPU, with `powermetrics` reporting the renderer around 606-752 CPU ms/s and the GPU helper around 132-161 CPU ms/s.
- A clean isolated dev instance on ports 13783/5183 did not show comparable baseline usage on the default screen.

Hypothesis:

- The ultrathink visual treatment was a plausible compositor stressor because it used multiple always-running CSS animations when active: `ultrathink-rainbow` and `ultrathink-chroma-shift` on the composer frame/model picker icon, plus additional animated pill/word surfaces.

Test:

- Injected `.ultrathink-frame` and `.ultrathink-word` elements into the dev composer to force the state on.
- With those animations active, Playwright Chrome GPU PID 3128 rose to about 20.7% CPU and renderer PID 3138 to about 11.7% CPU. `powermetrics` reported about 194 CPU ms/s for the GPU process and 110 CPU ms/s for the renderer.
- Temporarily changing those ultrathink classes to static styling dropped the same forced test to about 0.5% GPU CPU and 0.3% renderer CPU, with `powermetrics` around 6 CPU ms/s for GPU and 3 CPU ms/s for renderer.

Discard:

- The temporary CSS change was reverted. The user confirmed they do not use Claude or ultrathink, and those state conditions have never appeared in their sessions, so this cannot explain their reported idle heating.
- The A/B test remains useful evidence that continuous compositor animations can produce this class of energy spike, but the retained code has no ultrathink animation change and the investigation must continue on ordinary-session surfaces.

## 2026-06-17 21:25 +0100 - Iteration 4: Discarded terminal cursor blink hypothesis

Baseline:

- A clean isolated dev instance on ports 13783/5183 had no active Web Animations on the default thread screen and the Playwright Chrome renderer/GPU processes were effectively idle.
- Opening the ordinary terminal drawer created one running Web Animation from xterm: `blink_block_2` on `SPAN.xterm-cursor.xterm-cursor-blink.xterm-cursor-block`. This state does not require Claude, ultrathink, or an active agent run; it only requires an open terminal drawer.
- With the drawer open and idle before the fix, Playwright Chrome renderer PID 56198 measured about 4.9% CPU in `ps`; `powermetrics` reported about 39.5 CPU ms/s for that renderer and about 18.0 CPU ms/s for the Playwright Chrome GPU process.

Hypothesis:

- xterm's blinking cursor keeps the renderer/compositor waking while the terminal is idle. If a terminal drawer is left open across sessions, this creates persistent energy use even when no agent or shell output is active.

Temporary fix:

- Changed the xterm construction in `ThreadTerminalDrawer` from `cursorBlink: true` to `cursorBlink: false`.
- Added a browser test asserting that the terminal is constructed with a static cursor to prevent this regression from returning silently.

Verification:

- Reloaded the same dev page with the terminal drawer still open.
- `document.getAnimations({ subtree: true })` dropped from one running `blink_block_2` animation to zero, `.xterm-cursor-blink` elements dropped to zero, and the xterm instance remained mounted.
- In the same open-terminal idle state after the fix, Playwright Chrome renderer PID 56198 dropped to 0.0% CPU in `ps`; `powermetrics` reported about 4.2 CPU ms/s for that renderer and about 8.5 CPU ms/s for the Playwright Chrome GPU process.
- `pnpm exec vp test run --project browser src/components/ThreadTerminalDrawer.browser.tsx` passed from `apps/web`, covering the static cursor assertion.

Discard:

- The terminal cursor change and regression test were reverted. The user rarely has the app terminal open, so this state cannot plausibly account for the observed idle energy consumption.
- The measurement remains useful evidence for terminal-specific energy work, but no terminal code change is retained in this investigation.

## 2026-06-17 21:31 +0100 - Iteration 5: Right-panel and preview follow-up probes

Right panel / Version Control:

- Closed the terminal drawer, opened the right panel, and selected Version Control in the same isolated dev instance.
- The right-panel shell and settled Version Control surface both reported zero active Web Animations.
- A 20 second process poll while Version Control loaded and settled did not catch repeated Git subprocess churn from the patched dev instance. The server had short CPU spikes while loading state, then returned to low usage.
- No code change was made for Version Control in this iteration.

Browser / Preview:

- Inspected the preview empty-state/local-server code path because `PreviewLocalServerCard` uses an `animate-ping` listening indicator when a previewable local server is displayed.
- The Browser surface was disabled in the web dev runtime because the desktop preview bridge is unavailable, so this path could not be measured through the current Playwright web instance.
- No code change was made for preview indicators without a reproducible measurement in the desktop-preview-capable runtime.

Packaged app sampling:

- Sampled the currently hot installed T3 Code renderer PID 29728 and GPU helper PID 28787. The renderer sample showed mostly V8/Electron renderer work, and the GPU sample showed Metal/IOSurface rendering work.
- This confirmed that the remaining observed energy in the live packaged app is renderer/GPU-oriented, but the native samples did not identify a specific DOM element or app surface.

## 2026-06-17 23:03 +0100 - Iteration 6: Version Control Git work reduction

Baseline:

- The terminal cursor fix from iteration 4 was reverted because the user rarely has the in-app terminal open. That path remains documented as terminal-specific evidence only, not a retained fix for the observed ordinary idle heat.
- Started an isolated dev instance on ports 13785/5733, loaded it through Playwright, created a disposable project at `/tmp/t3code-vc-power/work`, and opened the normal Version Control right-panel surface.
- The disposable repo was altered into multiple Git states: two remotes with a branch behind its remote, a large untracked file set, and a large ignored output directory to exercise watcher churn.

Culprit 1: large untracked sets in the Version Control snapshot.

- The panel snapshot used `git status --porcelain=2 --branch -uall`, then ran `git diff --no-index --numstat` once per untracked path, and then created a temporary index with `git add -N` over every untracked path to run rename-aware `git diff` passes.
- In the throwaway repo with 301 untracked paths, the old detail path took `real 1.72s` (`user 0.89s`, `sys 0.65s`) for one snapshot refresh. The capped path keeps the file list from porcelain status but skips per-file stats and temporary-index rename detection when there are more than 100 untracked paths; the same state then took `real 0.01s`.
- Temporary mitigation, later superseded: cap expensive untracked detail loading in `SourceControlPanelService` for large untracked sets. This confirmed the source of the Git work, but it was not the desired product behavior because every changed row should remain visible and eligible for details.

Culprit 2: ignored filesystem churn while a VCS subscription is mounted.

- The local watcher previously ran one `git check-ignore --quiet -- <path>` subprocess before debounce for every non-`.git` filesystem event. Ignored build/cache output therefore still created Git process churn even when it should not trigger a status refresh.
- In the throwaway repo, 300 ignored output files took `real 1.58s` (`user 0.83s`, `sys 0.58s`) when checked as individual subprocesses. A single batched `git check-ignore -z --stdin` over the same paths completed below the measurable `time -p` precision (`real 0.00s`).
- Fix retained: batch watcher events over the existing debounce window and classify ignored paths with one `git check-ignore --stdin -z` call per batch.

Discarded culprit 3: duplicate background remote fetching from the panel.

- The VCS status broadcaster already owns automatic remote polling, but the Version Control panel also scheduled `git fetch --all` every 5 minutes while the panel was mounted. That extra timer could wake the app even with no user action and then cascade into status invalidation and panel refresh work.
- In the throwaway two-remote repo, one manual `git fetch --all` took `real 0.06s` even against local remotes. This is small in the synthetic repo but scales with network latency, remote count, credential prompts, branch count, and repository size; more importantly, it was a redundant idle timer.
- Discard: the 5-minute panel fetch behavior is intentional and was restored. A short operation every five minutes is not a plausible explanation for the sustained energy consumption reported by the user, so no fetch-timer change is retained from this iteration.

Verification:

- `pnpm exec vp test run apps/server/src/sourceControl/SourceControlPanelService.test.ts apps/server/src/vcs/VcsStatusBroadcaster.test.ts` passed with the initial regression coverage for deferring expensive untracked detail work and batching watcher ignored-path checks.
- Direct throwaway measurements show the two retained Git-path fixes dropping from seconds of Git subprocess work to near-zero work in the tested states.

## 2026-06-18 08:34 WEST - Iteration 7: Lazy visible-row working-tree enrichment

Follow-up:

- The 100-path cap from iteration 6 avoided the expensive path, but it was too blunt: the panel should still show all changed files immediately and should not permanently hide stats or rename detection from rows after the first 100 entries.
- The replacement approach keeps the cheap initial snapshot: `git status --porcelain=2 --branch -uall` still returns every row, but untracked per-file stats and temporary-index rename detection are deferred out of the snapshot path.

Fix retained:

- Added a `vcs.panel.enrichWorkingTreeFiles` RPC. The frontend requests enrichment only for rendered working-tree rows, batching rows over a short debounce window.
- Virtualized the Version Control working-tree list with the same `LegendList` approach used elsewhere in the app, using a 600 px draw margin so near-viewport rows can be enriched before the user reaches them.
- Cached enrichment results in the frontend for the lifetime of the current snapshot. Rows are not "unenriched" when they scroll away, and deleted rows with no detected rename are cached as unchanged deleted rows so they do not repeatedly trigger rename detection.
- Kept best-effort rename detection: visible untracked rows are compared against deleted paths through the existing temporary-index strategy, and visible deleted rows can use all current untracked paths as candidate destinations. When a rename is found, the server returns the new renamed row plus a hidden source path so the frontend can collapse the temporary delete/add pair into one `R` row.

Verification:

- `./node_modules/.bin/vp test run apps/server/src/sourceControl/SourceControlPanelService.test.ts apps/server/src/vcs/VcsStatusBroadcaster.test.ts apps/web/src/localApi.test.ts` passed with regression coverage for lazy snapshot behavior, visible untracked enrichment, visible deleted-source rename detection, and the retained batched watcher behavior.
- Started the web dev server on `http://127.0.0.1:5187/` and loaded it through the T3 preview. `preview_status` reported the `T3 Code (Dev)` tab loaded and idle at that URL.
