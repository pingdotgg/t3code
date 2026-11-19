# Agent Board build plan

Agent Board is a desktop app for running projects through an orchestrator on the T3 Code engine. The sidebar lists T3 projects, each project lists its boards, and each board shows one orchestrator, its tickets in lanes, the agents working each ticket, artifact cards, and For-you cards. The workflow it shows is the XEO-3330 run from November 2026.
The rule the program enforces is that the engine stays upstream. No PR edits a file that exists upstream, except `pnpm-lock.yaml`. Every PR passes `apps/board/scripts/check-engine-untouched.mjs`. The repo's lint and dependency standards apply to every file in the repo, and fail only on lines we add or change.
The PRs, in stack order, are B0, B1, S1, K1, B2, B3, B4, B5, B6, B7, B8, B9, B10, B11, and B12.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `skill://poteto-mode/playbooks/autopilot-stack.md`. The operator lands every PR. Every PR in the stack is an operator item that stops at STACK-READY, because the operator wants review before landing and each PR builds on the one below it.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `skill://poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `skill://swarm`
  - [ ] the OMP browser or terminal verification surface, with Orca's embedded browser through `orca-ide` as the default for web lanes
  - [ ] `skill://poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `skill://architect`, `skill://how`, `skill://interrogate`, `skill://no-comments`, `skill://unslop`, and `skill://technical-writing`
  - [ ] `skill://poteto-mode/playbooks/authoring-a-skill.md` for K1 and B12
- [ ] On the operator's go, arm the audit tick every 1h as a bounded `scout` watcher task, or as the hourly timed wake from the job control in `skill://pstack-omp` in a long-lived root, with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Base each PR on its parent's branch, because the execution playbook stacks.
  - [ ] B0 is first. It branches from `main` of `13kparkin/t3code`.
  - [ ] B1 after B0. S1 after B1. K1 after S1. B2 after K1. B3 after B2. B4 after B3. B5 after B4. B6 after B5.
  - [ ] B7 after B6. B8 after B7. B9 after B8. B10 after B9. B11 after B10. B12 after B11.
- [ ] Hold the file boundaries. Every PR touches only `apps/board/**`, `.github/workflows/agent-board.yml`, and `pnpm-lock.yaml`. S1 also adds `standards/**`, `.vite-hooks/pre-push`, and `.claude/settings.json`, which upstream does not have. K1 and B12 write outside the repo only through their install scripts.
- [ ] Hold the review gate. B1, B2, B4, B5, B6, B7, B8, B9, B10, and B11 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.
- [ ] Cap building agents at 2 at once, and run a push as the only heavy job, because this machine has 15 GB of RAM and 4 cores.

### PR mechanics, for every PR

- [ ] Resolve the repository forge once. Use `gh` against `13kparkin/t3code`, which is the configured forge for this fork. Record that choice in the decision trail.
- [ ] Open the PR ready, never draft, with the configured forge's create command, per `skill://poteto-mode/playbooks/opening-a-pr.md`. A stack child targets its parent branch.
- [ ] Run lint and typecheck once before the PR-facing push, as `vp lint apps/board` and `vp run --filter @agent-board/app typecheck`. From S1 on, also run `node standards/check-added-diagnostics.mjs`. Push with hooks on.
- [ ] Run `skill://unslop` before each commit and `skill://no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per `skill://poteto-mode/references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, or on a CI failure that comes from a change on trunk.
- [ ] Run `node apps/board/scripts/check-engine-untouched.mjs` before every push. A non-zero exit blocks the push.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `skill://swarm`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `skill://poteto-mode/playbooks/shipping.md`.
- [ ] Append a clean PR to the linear stack per `skill://poteto-mode/playbooks/autopilot-stack.md` step 7. A rebase voids verdicts above the changed head, and the patch-id rule in `skill://poteto-mode/playbooks/shipping.md` decides which verdicts survive. The operator lands the stack bottom-up.

### Boot recipe, for every live lane

Each live lane runs against a frozen PR head in its own worktree or disjoint output path. Drive it through the `browser` API inside `eval`, or through `bash` with `pty` for a TUI.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Start the engine and the surface, then wait for ready.
  - [ ] Run `vp i`, then `vp run --filter t3 build` once per worktree.
  - [ ] Start an isolated engine with `node apps/server/dist/bin.mjs serve --base-dir /tmp/board-lane-<n>/t3 --port <3800 + n> --no-browser`. Never point a lane at `~/.t3`.
  - [ ] Mint the lane token with `node apps/server/dist/bin.mjs auth session issue --base-dir /tmp/board-lane-<n>/t3 --token-only --label lane-<n>`.
  - [ ] For web lanes, run `AGENT_BOARD_ENGINE_URL=http://127.0.0.1:<3800 + n> AGENT_BOARD_TOKEN=<token> vp run --filter @agent-board/app dev:web` and open the printed URL in Orca's embedded browser with `orca-ide tab create --url <url> --json`.
  - [ ] For Electron lanes, run `AGENT_BOARD_CDP_PORT=<9300 + n> vp run --filter @agent-board/app dev:windows`, which launches the Windows build of Electron on the Windows PC, and attach the `browser` API inside `eval` to `http://127.0.0.1:<9300 + n>`. WSL's mirrored networking shares 127.0.0.1 with Windows. Capture the full window, frame included, with a PowerShell `CopyFromScreen` of the window bounds.
- [ ] Deliver input only through `orca-ide click`, `fill`, `keypress`, and `drag`, or the `browser` API actions. Read state only through `orca-ide eval` and `orca-ide snapshot`.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Guard the engine boundary (B0)

**Depends on.** None.

**Files.**

- [ ] Create `apps/board/package.json` with the name `@agent-board/app`, `"private": true`, and a `check:boundary` script.
- [ ] Create `apps/board/scripts/check-engine-untouched.mjs`.
- [ ] Create `apps/board/scripts/check-engine-untouched.test.mjs`.
- [ ] Create `.github/workflows/agent-board.yml`.
- [ ] Create `apps/board/README.md`.
- [ ] Create `apps/board/docs/plan.md`, which is this file.

**Build.**

- [ ] In `check-engine-untouched.mjs`, compute `git merge-base upstream/main HEAD`, list the paths changed since it, and exit 1 when any path falls outside `apps/board/`, `.github/workflows/agent-board.yml`, and `pnpm-lock.yaml`. Print each offending path.
- [ ] Exit 2 with the message `add the upstream remote` when the `upstream` remote is missing.
- [ ] In `agent-board.yml`, on every pull request to `main`, check out with full history, add the `upstream` remote for `pingdotgg/t3code` and fetch its `main`, then run the boundary check and `node --test apps/board/scripts/`. B1 adds `vp run --filter @agent-board/app typecheck` and `vp test run` to this job.

**You see.**

- [ ] `node apps/board/scripts/check-engine-untouched.mjs` prints `engine untouched: 0 paths outside apps/board` and exits 0.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `check-engine-untouched.test.mjs` builds a temporary git repo. An `apps/board` change exits 0. An `apps/server/src/x.ts` change exits 1 and prints that path. Run `node --test apps/board/scripts/`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the check at trunk and at head. Trunk does not have the script, so record that fact and gate the head result. Save `b0-regression.txt`. Pass when head exits 0 and prints 0 offending paths.
- [ ] Lane 2. Commit a one-line change to `apps/server/src/bin.ts` on a scratch branch and run the check. Save `b0-server.txt`. Pass when the check exits 1 and names `apps/server/src/bin.ts`.
- [ ] Lane 3. Commit a change to `packages/contracts/src/rpc.ts` and run the check. Save `b0-contracts.txt`. Pass when the check exits 1 and names that path.
- [ ] Lane 4. Commit a change to `apps/web/src/main.tsx` and run the check. Save `b0-web.txt`. Pass when the check exits 1 and names that path.
- [ ] Lane 5. Commit a new file `apps/board/src/probe.ts` and run the check. Save `b0-board.txt`. Pass when the check exits 0.
- [ ] Lane 6. Move `apps/desktop/src/main.ts` into `apps/board/` and run the check. Save `b0-move.txt`. Pass when the check exits 1 and names the old path.
- [ ] Lane 7. Run the check from `apps/board/` instead of the repo root. Save `b0-cwd.txt`. Pass when the output matches the root run.
- [ ] Lane 8. Remove the `upstream` remote in a scratch clone and run the check. Save `b0-no-upstream.txt`. Pass when the check exits 2 and prints `add the upstream remote`.
- [ ] Lane 9. Merge `upstream/main` into a scratch branch that holds the B0 commit and run the check. Save `b0-after-upstream-merge.txt`. Pass when the check exits 0.
- [ ] Lane 10. Push the head branch and read the `agent-board` workflow run with `gh run view`. Save `b0-ci.txt`. Pass when the `agent-board` job is green.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of one check run. Trunk does not have the check, so the budget is absolute.
- [ ] Probe. Run `time node apps/board/scripts/check-engine-untouched.mjs` five times at head.
- [ ] Baseline. Record that trunk has no check, then record the five head times.
- [ ] Rule. The median stays under 1.5 s. A median at or over 1.5 s fails.

**Review gate.** None. B0 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B0 to the base-branch stack and the operator lands it bottom-up.

## Scaffold the desktop app (B1)

**Depends on.** B0.

**Files.**

- [ ] Edit `apps/board/package.json` to add `dev`, `dev:web`, `build`, `start`, `typecheck`, and `test` scripts, plus `react`, `react-dom`, `electron`, `tailwindcss`, `@tailwindcss/vite`, `lucide-react`, and `@fontsource-variable/inter` from the workspace catalog.
- [ ] Create `apps/board/vite.config.ts` and `apps/board/tsconfig.json`.
- [ ] Create `apps/board/electron/main.ts` and `apps/board/electron/preload.ts`.
- [ ] Create `apps/board/index.html`, `apps/board/src/main.tsx`, `apps/board/src/App.tsx`, and `apps/board/src/theme.css`.
- [ ] Create `apps/board/src/board/Viewport.tsx`, `apps/board/src/board/viewport.ts`, and `apps/board/src/board/viewport.test.ts`.
- [ ] Create `apps/board/src/sidebar/Sidebar.tsx`.
- [ ] Edit `.github/workflows/agent-board.yml` to run `vp run --filter @agent-board/app typecheck` and `vp test run` from `apps/board`.

**Build.**

- [ ] In `electron/main.ts`, open one window that loads the Vite dev server in development and the `agentboard://app` protocol in production. Turn on remote debugging when `AGENT_BOARD_CDP_PORT` is set.
- [ ] In `theme.css`, set the dark tokens from the approved prototype at `artifacts/agent-board-prototype/index.html`, and draw the dot grid on the board canvas.
- [ ] Replace the default OS title bar with T3 Code's. Copy T3 desktop's hidden title bar with dark overlay window controls, the hidden menu bar, and the dark background before first paint from `apps/desktop/src/window/DesktopWindow.ts`. Draw a dark top bar at the overlay height with a drag region, so the close, minimize, and maximize buttons sit on dark.
- [ ] Leave the window frame to Windows 11, which rounds the corners and draws the caption buttons over the dark overlay. Use no frameless or transparent window.
- [ ] In `viewport.ts`, implement pan, zoom around the cursor between 0.3 and 2, and fit to content with a 0.7 floor. `Viewport.tsx` renders the dotted canvas with zoom buttons.
- [ ] In `Sidebar.tsx`, render the empty Projects and Workspace sections and a footer slot.
- [ ] Make `dev:web` run the renderer in a plain browser for web lanes.
- [ ] Add `dev:windows`. Run from WSL, it builds the main and preload bundles, starts the Vite dev server in WSL, keeps a matching Electron `win32-x64` binary in `C:\Users\Kyle\AppData\Local\agent-board\`, copies the bundles to a Windows folder, and launches `electron.exe` there. The app is a Windows app, and the engine stays in WSL.

**You see.**

- [ ] `vp run --filter @agent-board/app dev` opens a dark window titled `Agent Board` with the sidebar and the dotted canvas.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `viewport.test.ts` asserts that zooming at a point keeps that point within 0.5 px, that zoom clamps at 0.3 and 2, and that fit never returns less than 0.7. Run `vp test run src/board/viewport.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have the app, so record that fact and gate the head. Open web dev mode at head. Save `b1-regression.png`. Pass when the dark sidebar and the dotted canvas render.
- [ ] Lane 2. Launch the app on Windows with `dev:windows` and attach over CDP. Save `b1-electron.png`. Pass when the window title is `Agent Board`, the DOM matches web dev mode, and the full-window capture shows dark caption buttons on the dark bar and rounded corners.
- [ ] Lane 3. Drag the empty canvas 200 px right. Save `b1-pan.png`. Pass when the dot grid offset moved 200 px.
- [ ] Lane 4. Press Ctrl and scroll up over a fixed point. Save `b1-zoom.png`. Pass when the zoom label rises and the point under the cursor stays within 2 px.
- [ ] Lane 5. Click zoom in, zoom out, and fit. Save `b1-zoom-buttons.png`. Pass when the label changes on each click and fit returns 70% or more.
- [ ] Lane 6. Resize the window to 1170 by 930, then 1600 by 1000. Save `b1-resize.png`. Pass when the sidebar stays 240 px wide and the body has no horizontal scrollbar.
- [ ] Lane 7. Reload the page and read the console. Save `b1-console.png`. Pass when the console has no errors.
- [ ] Lane 8. Build the Windows package with `vp run --filter @agent-board/app build`, then launch it on Windows. Save `b1-production.png`. Pass when the renderer loads from `agentboard://app`.
- [ ] Lane 9. Press Tab through the sidebar. Save `b1-focus.png`. Pass when each focused item shows a visible focus ring.
- [ ] Lane 10. Run the boundary check at head. Save `b1-boundary.txt`. Pass when it exits 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from Electron process start to the renderer mark `board:first-paint`. Trunk does not have the app, so the budget is absolute.
- [ ] Probe. Launch the Windows production build five times and read the logged mark each time.
- [ ] Baseline. Record that trunk has no app, then record the five head times.
- [ ] Rule. The median stays under 1500 ms and no run exceeds 2500 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, and 4 screenshots into `apps/board/docs/media/b1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/b1-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B1 to the base-branch stack and the operator lands it bottom-up.

## Enforce the repo's lint and dependency standards (S1)

**Depends on.** B1.

**Files.**

- [ ] Create `standards/oxlint.config.ts` with the ZAIkai rule set, every rule at `error`.
- [ ] Create `standards/rules/anti-slop/` with the 13 anti-slop rules and their tests, ported from ZAIkai's `tools/oxlint/anti-slop/`.
- [ ] Create `standards/rules/project/` with the generic ZAIkai project rules and their tests, ported from ZAIkai's `tools/oxlint/project-rules/`.
- [ ] Create `standards/.dependency-cruiser.cjs` and its baseline `standards/dependency-baseline.json`.
- [ ] Create `standards/check-added-diagnostics.mjs` and `standards/check-added-diagnostics.test.mjs`.
- [ ] Create `standards/hooks/lint-touched-file.mjs` and `standards/hooks/gate-commit.mjs`.
- [ ] Create `.claude/settings.json` and `.vite-hooks/pre-push`.
- [ ] Edit `apps/board/package.json` to add `dependency-cruiser` and the `standards` script.
- [ ] Edit `apps/board/tsconfig.json` to add `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, and `noPropertyAccessFromIndexSignature`.
- [ ] Edit `apps/board/scripts/check-engine-untouched.mjs` and its test to allow `standards/`, `.vite-hooks/pre-push`, and `.claude/settings.json`.
- [ ] Edit `.github/workflows/agent-board.yml` to run the standards check and `node --test standards/`.

**Build.**

- [ ] In `oxlint.config.ts`, load the anti-slop and project rules as `jsPlugins`, imported from `vite-plus/lint/plugins` instead of `@oxlint/plugins`. Turn on the ZAIkai built-ins too. These are `typescript/ban-ts-comment`, `no-explicit-any`, `no-namespace`, `no-non-null-asserted-optional-chain`, `no-require-imports`, `no-unused-vars` with the `^_` ignore, `max-lines` at 500, `react/no-multi-comp`, and `import/no-cycle`.
- [ ] Port these project rules. They are `no-unbounded-promise-fan-out`, `no-use-effect`, `no-process-env-outside-runtime-profile`, `no-agent-debug-instrumentation`, `enum-property-types`, `no-fixed-sleep`, `no-unsignaled-poll`, and `no-shared-worker-state`. Leave out ZAIkai's domain and design-system rules and `no-module-level-functions`, which fights T3's function style.
- [ ] In `.dependency-cruiser.cjs`, write the ZAIkai-style dependency rules.
  - [ ] `no-cross-app-imports`. An app never imports another app's files. `apps/board` reaches T3 only through `@t3tools/contracts` and `@t3tools/client-runtime/<subpath>`.
  - [ ] `packages-not-apps`. Nothing under `packages/` imports from `apps/`.
  - [ ] `renderer-not-main`. `apps/board/src/` never imports `apps/board/electron/` or a Node built-in, and `apps/board/electron/` never imports `react`.
  - [ ] `domain-is-pure`. `apps/board/src/domain/` imports only other domain files and `effect`.
  - [ ] `no-circular` across the repo, and `no-orphans` in `apps/board`.
- [ ] Record today's upstream violations once with `depcruise-baseline` into `dependency-baseline.json`. The check passes them with `--ignore-known`, so only new violations fail.
- [ ] In `check-added-diagnostics.mjs`, list files changed since `git merge-base upstream/main HEAD`, or take `--files`. Run oxlint with `vp lint -c standards/oxlint.config.ts --format=json` on them, and keep only diagnostics on lines that `git diff -U0` shows as added. Run dependency-cruiser with the baseline on the same files. Print each finding with its file, line, and rule, and exit 1 on any finding.
- [ ] First prove that `vp lint -c` skips the root `lint` block of `vite.config.ts`. If it does not, call the bundled oxlint binary with `-c` directly, and record which in the decision trail.
- [ ] In `.claude/settings.json`, run `standards/hooks/lint-touched-file.mjs` on PostToolUse for `Edit`, `MultiEdit`, and `Write`. It checks the edited file and returns findings as `hookSpecificOutput.additionalContext`, or nothing when clean. Run `standards/hooks/gate-commit.mjs` on PreToolUse for `Bash`. When the command runs `git commit` or `git push`, it runs the full check and denies the call with the findings as `permissionDecisionReason`.
- [ ] In `.vite-hooks/pre-push`, run `node standards/check-added-diagnostics.mjs`. The existing `.vite-hooks/_/pre-push` wrapper already calls it.
- [ ] Fix every finding in the B1 code.

**You see.**

- [ ] An agent that writes a function with an `unknown` parameter anywhere in the repo sees the anti-slop finding right after the edit, cannot commit it, and cannot push it.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `check-added-diagnostics.test.mjs` builds a temporary git repo whose upstream commit holds one violation. Adding a clean line beside it exits 0. Adding a second violation exits 1 and prints only the new line. Every ported rule keeps its own test. Run `node --test standards/`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have the standards, so record that fact. Run the check at head. Save `s1-regression.txt`. Pass when it exits 0, which proves the S1 and B1 code comply.
- [ ] Lane 2. Commit an `apps/board` file with an `unknown` parameter on a scratch branch and run the check. Save `s1-added-line.txt`. Pass when it exits 1 and names the rule and the line.
- [ ] Lane 3. Point a scratch `upstream/main` at a commit that holds a violation, add a clean line to that file, and run the check. Save `s1-old-line.txt`. Pass when it exits 0.
- [ ] Lane 4. Import a file from `apps/server/src/` in `apps/board/src/`. Save `s1-cross-app.txt`. Pass when the check exits 1 and names `no-cross-app-imports`.
- [ ] Lane 5. Import `apps/board/electron/main.ts` from `apps/board/src/`. Save `s1-renderer.txt`. Pass when the check exits 1 and names `renderer-not-main`.
- [ ] Lane 6. Run dependency-cruiser on the whole repo with the baseline. Save `s1-baseline.txt`. Pass when it exits 0.
- [ ] Lane 7. In a scratch worktree, ask `claude -p` to write a TypeScript file with an `unknown` parameter. Save `s1-claude-lint.txt`. Pass when the session transcript shows the finding as added context after the Write.
- [ ] Lane 8. Ask the same session to commit that file. Save `s1-claude-gate.txt`. Pass when the Bash call is denied with the finding.
- [ ] Lane 9. Push a violating commit to a scratch bare remote. Save `s1-pre-push.txt`. Pass when the push fails and prints the finding.
- [ ] Lane 10. Push the head branch and read the `agent-board` run with `gh run view`. Save `s1-ci.txt`. Pass when the standards step and the rule tests are green.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of the lint hook on one edited file, and of the full check on a 20-file diff. Trunk does not have the check, so the budgets are absolute.
- [ ] Probe. Time five runs of each at head.
- [ ] Baseline. Record that trunk has no check, then record the head times.
- [ ] Rule. The hook median stays under 2 s, and the full check median stays under 30 s.

**Review gate.** None. S1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends S1 to the base-branch stack and the operator lands it bottom-up.

## Bring the omp rules, LSP, and persistent env to every Claude Code session (K1)

**Depends on.** S1.

**Files.**

- [ ] Create `apps/board/plugins/.claude-plugin/marketplace.json` that lists one plugin, `omp-kit`.
- [ ] Create `apps/board/plugins/omp-kit/.claude-plugin/plugin.json`, `apps/board/plugins/omp-kit/hooks/hooks.json`, and `apps/board/plugins/omp-kit/.lsp.json`.
- [ ] Create `apps/board/plugins/omp-kit/engine/rules.mjs`, `apps/board/plugins/omp-kit/engine/hook.mjs`, and `apps/board/plugins/omp-kit/engine/rules.test.mjs`.
- [ ] Create `apps/board/scripts/install-omp-kit.mjs`.

**Build.**

- [ ] In `rules.mjs`, load the rules from `~/.omp/agent/rules/*.md` at hook time, so omp and Claude Code share one rule set. Read `description`, `condition`, `scope`, and `interruptMode` from each frontmatter. `OMP_KIT_RULES_DIR` overrides the folder.
- [ ] Map omp scopes to Claude Code. `tool:edit` and `tool:write` match `Edit`, `MultiEdit`, and `Write`, and a scope glob tests `tool_input.file_path`. `tool:bash` matches `Bash`. `text` matches the last assistant message. Drop `thinking`, because no hook sees it.
- [ ] In `hook.mjs`, handle four events.
  - [ ] PreToolUse. Match tool rules against `tool_input`, which is the command, or `new_string` and `content`. An interrupt rule denies the call with the rule body as `permissionDecisionReason`. A remind rule waits for the PostToolUse of that call.
  - [ ] PostToolUse. Return waiting remind rules as `hookSpecificOutput.additionalContext`, in omp's `system-reminder` wording.
  - [ ] Stop. Match text rules against the last assistant message in `transcript_path`. An interrupt rule returns `decision: "block"` with the rule body, which starts one more turn. A remind rule waits for the next PostToolUse or UserPromptSubmit.
  - [ ] SessionStart. Return `~/.omp/agent/RULES.md` as added context. Write `. ~/.config/vite-plus/env` into `CLAUDE_ENV_FILE`, so `vp` and anything the agent appends to that file persist across Bash calls.
- [ ] Fire each rule once per session, as omp does. Keep the fired names in a state file per `session_id` in the plugin's data folder.
- [ ] In `.lsp.json`, register `typescript-language-server --stdio` for `.ts`, `.tsx`, `.js`, and `.mjs`, so Claude Code's LSP tool and its diagnostics after edits work.
- [ ] In `install-omp-kit.mjs`, run `claude plugin marketplace add apps/board/plugins` and `claude plugin install omp-kit@agent-board --scope user`. Skip each step that is already done.

**You see.**

- [ ] Every Claude Code session on this machine, T3 Claude threads included, gets an omp rule when it matches, the LSP tool, and `vp` on its Bash path.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `rules.test.mjs` loads three fixture rules, a remind rule scoped to `tool:edit(*.ts)`, an interrupt rule scoped to `tool:bash`, and a text rule. It asserts the literal hook output for a matching Edit, the same Edit on a `.md` file, a matching Bash command, a matching last message, and a second match in the same session, which stays silent. Run `node --test apps/board/plugins/omp-kit/engine/`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have the plugin, so record that fact. Run the install script at head. Save `k1-install.txt`. Pass when `claude plugin list` shows `omp-kit` enabled at user scope.
- [ ] Lane 2. Run the install script again. Save `k1-reinstall.txt`. Pass when it reports both steps skipped.
- [ ] Lane 3. Ask `claude -p` to write a `.ts` file that matches the `code-quality-anti-smell` rule. Save `k1-remind.txt`. Pass when the transcript shows that rule's reminder after the Write.
- [ ] Lane 4. Ask a session to run a Bash command that matches `linear-writes-require-approval`. Save `k1-deny.txt`. Pass when the call is denied with that rule's text.
- [ ] Lane 5. Prompt a session so its reply matches the `surgical-changes` rule twice in a row. Save `k1-text.txt`. Pass when the Stop hook blocks once with the rule body and stays silent the second time.
- [ ] Lane 6. Repeat lane 5 in a new session. Save `k1-new-session.txt`. Pass when the rule fires again.
- [ ] Lane 7. Ask a session for the references to a symbol in `apps/board/src`. Save `k1-lsp.txt`. Pass when the LSP tool returns them.
- [ ] Lane 8. Ask a session to run `vp --version` in Bash with no setup. Save `k1-env.txt`. Pass when it prints the version.
- [ ] Lane 9. Repeat lane 3 in a T3 Claude thread on an isolated engine. Save `k1-t3-thread.txt`. Pass when the reminder shows in the thread.
- [ ] Lane 10. Point `OMP_KIT_RULES_DIR` at a scratch copy with one rule changed, and start a session. Save `k1-rules-dir.txt`. Pass when the changed rule is the one that fires.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of one PreToolUse hook run with all 26 rules loaded. Trunk does not have the plugin, so the budget is absolute.
- [ ] Probe. Run `hook.mjs` 50 times on a fixed Edit payload.
- [ ] Baseline. Record that trunk has no plugin, then record the head distribution.
- [ ] Rule. The p95 stays under 150 ms.

**Review gate.** None. K1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends K1 to the base-branch stack and the operator lands it bottom-up.

## Boot or join the WSL engine and list its projects (B2)

**Depends on.** K1.

**Files.**

- [ ] Create `apps/board/electron/engine.ts`, `apps/board/electron/wslEngine.ts`, and `apps/board/electron/engine.test.ts`.
- [ ] Create `apps/board/electron/ipc.ts`.
- [ ] Create `apps/board/src/connection/platform.ts` and `apps/board/src/connection/runtime.ts`.
- [ ] Create `apps/board/src/state/projects.ts`.
- [ ] Create `apps/board/src/sidebar/ProjectList.tsx` and `apps/board/src/sidebar/EngineStatus.tsx`.
- [ ] Edit `apps/board/package.json` to add `@t3tools/client-runtime`, `@t3tools/contracts`, `effect`, and `@effect/atom-react`.

**Build.**

- [ ] In `wslEngine.ts`, run every engine command inside WSL through `wsl.exe -d <distro> --cd ~ --exec`, with the login-shell `PATH`, the way T3 desktop does (`apps/desktop/src/backend/DesktopBackendConfiguration.ts:727-752`). The distro is WSL's default, and a setting picks another from `wsl.exe --list --verbose`. On Linux, run the same commands directly.
- [ ] In `engine.ts`, find the engine in this order, so installing the app is enough to reach the WSL dev environment.
  - [ ] `AGENT_BOARD_ENGINE_URL`, when set.
  - [ ] Join a running engine. Read `~/.t3/userdata/server-runtime.json` in the distro, and use its `origin` when its `pid` is alive and the origin answers. That shares projects and threads with T3 desktop's WSL backend or T3's service. `AGENT_BOARD_T3_HOME` overrides `~/.t3` for lanes.
  - [ ] Boot one. Start `t3 serve` from the login `PATH`, or else the newest T3 runtime T3 desktop installed under `~/.t3/wsl-runtime/`, as a child process the app owns. Stop it when the app quits. Never stop an engine the app joined.
  - [ ] Install one. When WSL has no T3 runtime, ask once, then run T3's install script (`curl -fsSL https://t3.codes/install.sh | sh`) inside WSL and boot it.
- [ ] Mint a bearer with that runtime's `auth session issue --token-only --label agent-board --ttl 30d` through `wslEngine.ts`. `AGENT_BOARD_T3_CLI` overrides the command. Store the token with Electron `safeStorage`. On a 401, mint a new token once, then surface `auth_failed`.
- [ ] In `platform.ts` and `runtime.ts`, build the connection runtime the way `apps/mobile/src/connection/platform.ts` and `runtime.ts` do, with a bearer target registered through `ConnectionOnboarding`.
- [ ] In `state/projects.ts`, read projects with `createEnvironmentProjectAtoms`. `ProjectList.tsx` lists them.
- [ ] In `EngineStatus.tsx`, show how the app reached the engine and its phase, as `Engine connected · joined`, `Engine connected · booted`, `Starting engine in WSL`, `Connecting`, or `Offline`.

**You see.**

- [ ] On a fresh launch with nothing running, the app starts the engine in WSL itself, and the sidebar lists the projects from that environment.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `engine.test.ts` uses a fake `wsl.exe` runner and a fake fetch. It asserts the discovery order, that a stale `server-runtime.json` (dead `pid`) leads to a boot, that the app stops only an engine it booted, exactly one reissue on the first 401, and the `auth_failed` error on the second 401. Run `vp test run electron/engine.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have the app, so record that fact. Seed three projects in the lane engine and open the head app. Save `b2-regression.png`. Pass when the sidebar lists the three seeded project names.
- [ ] Lane 2. Start the Windows app with no engine running in WSL. Save `b2-boot.png`. Pass when the footer shows `Starting engine in WSL`, then `Engine connected · booted` within 15 s, and the WSL process list shows the child engine.
- [ ] Lane 3. Quit the app after lane 2. Save `b2-quit.txt`. Pass when the booted engine process is gone within 5 s.
- [ ] Lane 4. Revoke the lane token with `auth session revoke`. Save `b2-reissue.png`. Pass when the app logs one reissue and reconnects.
- [ ] Lane 5. Add a project through the engine CLI while the app runs. Save `b2-add-project.png`. Pass when the project appears within 2 s.
- [ ] Lane 6. Archive a project through the engine. Save `b2-archive-project.png`. Pass when the project leaves the list within 2 s.
- [ ] Lane 7. Start an engine in WSL first, as T3 desktop's WSL backend does, then open the app. Save `b2-join.png`. Pass when the footer shows `Engine connected · joined`, and quitting the app leaves that engine running.
- [ ] Lane 8. Point `AGENT_BOARD_T3_HOME` at an empty folder with no T3 runtime on the `PATH`. Save `b2-install.png`. Pass when the app asks before installing, and a decline leaves the footer on `Offline` with the reason.
- [ ] Lane 9. Seed 50 projects. Save `b2-many.png`. Pass when the list scrolls and the footer stays visible.
- [ ] Lane 10. Run the boundary check at head. Save `b2-boundary.txt`. Pass when it exits 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from app start to the connected footer against a warm local engine. Trunk does not have the app, so the budget is absolute.
- [ ] Probe. Start the app five times against a running lane engine and read the `board:engine-connected` mark.
- [ ] Baseline. Record that trunk has no app, then record the five head times.
- [ ] Rule. The median stays under 3000 ms. A median at or over 3000 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, and 4 screenshots into `apps/board/docs/media/b2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/b2-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B2 to the base-branch stack and the operator lands it bottom-up.

## Probe the engine behaviors the board depends on (B3)

**Depends on.** B2.

**Files.**

- [ ] Create `apps/board/scripts/engine-probe.ts` and `apps/board/scripts/engine-probe.test.ts`.
- [ ] Create `apps/board/docs/engine-findings.md`.

**Build.**

- [ ] In `engine-probe.ts`, reuse `electron/engine.ts` for the token and run ten checks against an isolated engine with the operator's Claude Code login. Each check prints `PASS` or `FAIL` with its evidence lines.
  - [ ] Check A. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=60` from `~/.claude/settings.json` reaches a T3 Claude thread.
  - [ ] Check B. `delegate_task` with `isolation: 'worktree'` creates a worktree and a child whose `lineage.parentThreadId` is the parent.
  - [ ] Check C. A child can call `delegate_task` itself.
  - [ ] Check D. A child in `approval-required` mode shows a `pendingRuntimeRequest`, and `runtime-request.respond` from the board's connection resolves it.
  - [ ] Check E. A child question wakes the parent thread.
  - [ ] Check F. `projects.readFile` and `projects.listEntries` accept an absolute path.
  - [ ] Check G. An `assets.createUrl` `media-file` URL for an absolute path loads without an auth header.
  - [ ] Check H. Archiving a parent leaves its children unarchived, and archiving is refused while a child runs.
  - [ ] Check I. A T3 Claude thread writes and later reads Claude Code's own project memory under `~/.claude/projects/<project>/memory/`.
  - [ ] Check J. A T3 Claude thread can drive a page with the `preview_*` tools while no board or web client is connected.
- [ ] Write the results table into `engine-findings.md`, with the follow-up each failure needs in B5 to B9.

**You see.**

- [ ] `node apps/board/scripts/engine-probe.ts` prints ten result rows, and `engine-findings.md` holds the same ten rows.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `engine-probe.test.ts` asserts that `summarize()` turns three fixed results into the literal markdown rows expected. Run `vp test run scripts/engine-probe.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have the probe, so record that fact. Run the full probe at head. Save `b3-full.txt`. Pass when all ten rows print and `engine-findings.md` matches them.
- [ ] Lane 2. Run check A alone. Save `b3-check-a.txt`. Pass when the row shows the observed compaction threshold and the verdict.
- [ ] Lane 3. Run check B alone. Save `b3-check-b.txt`. Pass when the row names the child thread, its worktree path, and its parent id.
- [ ] Lane 4. Run check C alone. Save `b3-check-c.txt`. Pass when the row names a grandchild thread.
- [ ] Lane 5. Run check D alone. Save `b3-check-d.txt`. Pass when the row shows the request id before and its resolved status after.
- [ ] Lane 6. Run check E alone. Save `b3-check-e.txt`. Pass when the row shows the parent's wake message.
- [ ] Lane 7. Run checks F and G alone. Save `b3-check-fg.txt`. Pass when the rows show both file calls with their result or error, and the HTTP status of the unauthenticated GET.
- [ ] Lane 8. Run check I alone. Save `b3-check-i.txt`. Pass when the row shows the memory file path and the fact the second session read back.
- [ ] Lane 9. Run check H alone. Save `b3-check-h.txt`. Pass when the row shows the refused archive and the children's archive state.
- [ ] Lane 10. Run check J alone. Save `b3-check-j.txt`. Pass when the row shows the preview snapshot text, or the error that says a host is needed.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of the full probe and of each check. Trunk does not have the probe, so the budget is absolute.
- [ ] Probe. Time two full runs at head and read the per-check times the probe logs.
- [ ] Baseline. Record that trunk has no probe, then record both head runs.
- [ ] Rule. A full run stays under 15 minutes and no check exceeds 3 minutes.

**Review gate.** None. B3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B3 to the base-branch stack and the operator lands it bottom-up.

## Show the engine version and update the engine from the app (B4)

**Depends on.** B3.

**Files.**

- [ ] Create `apps/board/src/state/engineUpdate.ts` and `apps/board/src/state/engineUpdate.test.ts`.
- [ ] Create `apps/board/src/sidebar/EngineVersion.tsx`.

**Build.**

- [ ] In `engineUpdate.ts`, read the engine version and the `serverSelfUpdate` capability from the server config, and the newest release from `server.getNpmRelease`. Follow `packages/client-runtime/src/connection/outdatedHostUpdate.ts`.
- [ ] Update the way the engine was reached. For T3's service, start `server.updateServerWithProgress`, keep its `updateId`, and match it to the `ready` lifecycle event after the reconnect to report committed or rolled back. For an engine the app booted from `t3` on the `PATH`, run `t3 update` in WSL, then restart the child. For an engine joined from T3 desktop's runtime, show the version only, because T3 desktop updates its own runtime.
- [ ] In `EngineVersion.tsx`, show `Engine <version>` and, when a newer release exists and the app can update that engine, an `Update to <version>` button with progress.

**You see.**

- [ ] The sidebar footer shows the engine version, and an update button appears only when the engine can update itself.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `engineUpdate.test.ts` asserts the outcome for a matching `updateId` with `committed`, a matching `updateId` with a rollback, and a missing `updateId`, against literal expected states. Run `vp test run src/state/engineUpdate.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have the app, so record that fact. Open the head app against a lane engine. Save `b4-regression.png`. Pass when the footer shows the lane engine's version.
- [ ] Lane 2. Join an engine started from T3 desktop's runtime under `~/.t3/wsl-runtime/`. Save `b4-joined-desktop.png`. Pass when the version shows and no update button shows.
- [ ] Lane 3. Install the previous `t3` release as a user service in a scratch home, then open the app. Save `b4-outdated.png`. Pass when the button names the newest release.
- [ ] Lane 4. Click the update button on the lane 3 service. Save `b4-progress.png`. Pass when progress shows downloading, then installing.
- [ ] Lane 5. Wait for the reconnect after lane 4. Save `b4-committed.png`. Pass when the footer shows the new version and the outcome reads committed.
- [ ] Lane 6. Stop the network during an update download. Save `b4-failed.png`. Pass when the app shows the failure and the old version still runs.
- [ ] Lane 7. Reload the app during an update. Save `b4-reload.png`. Pass when the app recovers the outcome after the reconnect.
- [ ] Lane 8. Open the app when the release lookup fails. Save `b4-lookup-fail.png`. Pass when the version shows and no button shows.
- [ ] Lane 9. Uninstall the scratch service with `t3 service uninstall`. Save `b4-cleanup.txt`. Pass when `systemctl --user status t3code.service` reports no unit.
- [ ] Lane 10. Run the boundary check at head. Save `b4-boundary.txt`. Pass when it exits 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Startup time added by the version and release lookup. Trunk does not have the app, so the budget is absolute against B3's head.
- [ ] Probe. Start the B3 head and the B4 head five times each, interleaved, and read `board:engine-connected`.
- [ ] Baseline. Record the B3 head times first.
- [ ] Rule. The B4 median stays within 200 ms of the B3 median.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 3, 4, and 5 screenshots into `apps/board/docs/media/b4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/b4-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B4 to the base-branch stack and the operator lands it bottom-up.

## Add boards under projects with archive and restore (B5)

**Depends on.** B4.

**Files.**

- [ ] Create `apps/board/src/domain/board.ts` and `apps/board/src/domain/board.test.ts`.
- [ ] Create `apps/board/src/store/boardFiles.ts`.
- [ ] Create `apps/board/src/store/localState.ts`.
- [ ] Create `apps/board/src/sidebar/BoardList.tsx` and `apps/board/src/board/CreateBoard.tsx`.

**Build.**

- [ ] In `domain/board.ts`, define the `board.json` schema with Effect Schema. The fields are `id`, `slug`, `name`, `projectId`, `orchestratorThreadId`, `createdAt`, `archived`, and `builderCap`.
- [ ] In `boardFiles.ts`, list boards from `.agentboard/*/board.json` in the project with `projects.listEntries` and `projects.readFile`. Create a board with `projects.writeFile`, and write `.agentboard/.gitignore` with the single line `*` so git ignores the whole folder.
- [ ] In `localState.ts`, keep card positions and the last opened board in the app's user data folder through IPC.
- [ ] In `BoardList.tsx`, nest boards under their project, hide archived boards, and add a **Show archived** toggle per project.
- [ ] To archive a board, stop the orchestrator with `thread.stop` and `stopDelegatedTasks`, archive every thread from `orchestration.getThreadFamily`, then set `archived` to true. Restore reverses each step.

**You see.**

- [ ] A new board appears under its project. Archiving hides it, and **Show archived** brings it back with its threads.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `board.test.ts` decodes a valid `board.json`, rejects one with a missing `name` and names that field in the error, and turns `Claude connector` into the slug `claude-connector`, then `claude-connector-2` on a clash. Run `vp test run src/domain/board.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have boards, so record that fact. Create the board `Claude connector` under a seeded project. Save `b5-create.png`. Pass when the board shows under that project.
- [ ] Lane 2. Run `git status --porcelain` in the project after lane 1. Save `b5-git-clean.txt`. Pass when the output is empty.
- [ ] Lane 3. Archive the board. Save `b5-archive.png`. Pass when the board leaves the list and `board.json` holds `"archived": true`.
- [ ] Lane 4. Turn on **Show archived** and restore the board. Save `b5-restore.png`. Pass when the board returns and its threads are unarchived.
- [ ] Lane 5. Archive a board whose orchestrator has a running child from the B3 probe scenario. Save `b5-archive-running.png`. Pass when the child stops first and every family thread ends archived.
- [ ] Lane 6. Create a second board named `Claude connector`. Save `b5-slug.png`. Pass when its folder is `claude-connector-2`.
- [ ] Lane 7. Break a `board.json` by hand. Save `b5-invalid.png`. Pass when the sidebar shows that board with an error badge naming the bad field.
- [ ] Lane 8. Restart the app. Save `b5-restart.png`. Pass when the boards and the archived state are unchanged.
- [ ] Lane 9. Seed 20 projects with 20 boards each. Save `b5-many.png`. Pass when the sidebar scrolls and each project expands.
- [ ] Lane 10. Run the boundary check at head. Save `b5-boundary.txt`. Pass when it exits 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Sidebar render time with 20 projects and 20 boards each. Trunk does not have boards, so the budget is absolute.
- [ ] Probe. Record a React profiler trace of the first sidebar render five times.
- [ ] Baseline. Record that trunk has no boards, then record the five head times.
- [ ] Rule. The median commit time stays under 50 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 3, and 4 screenshots into `apps/board/docs/media/b5-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/b5-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B5 to the base-branch stack and the operator lands it bottom-up.

## Start a board's orchestrator with the omp roles and talk to it (B6)

**Depends on.** B5.

**Files.**

- [ ] Create `apps/board/src/orchestrator/brief.md`, `apps/board/src/orchestrator/brief.ts`, and `apps/board/src/orchestrator/brief.test.ts`.
- [ ] Create `apps/board/src/orchestrator/launch.ts`.
- [ ] Create `apps/board/src/providers/ProviderPicker.tsx` and `apps/board/src/providers/SignIn.tsx`.
- [ ] Create `apps/board/src/board/OrchestratorCard.tsx` and `apps/board/src/chat/OrchestratorPanel.tsx`.
- [ ] Create `apps/board/roles/` with one markdown file per active omp role, 18 in all. Port `task`, `scout`, `reviewer`, and `security-reviewer` from omp's bundled `src/prompts/agents/`, and `sonic` from its `src/task/agents.ts`. Port `comment-sicko` and `poteto-agent` from the pstack-omp plugin, `thermo-nuclear-review-subagent` and `thermo-nuclear-code-quality-review-subagent` from thermos-omp, and the nine `egm-*` roles from egm.
- [ ] Create `apps/board/src/orchestrator/roles.ts` and `apps/board/src/orchestrator/roles.test.ts`.

**Build.**

- [ ] In `ProviderPicker.tsx`, list Claude Code and Codex instances and their models from the server config providers, with each instance's sign-in state. `SignIn.tsx` runs `provider.auth.start` for an unauthenticated instance.
- [ ] In `roles.ts`, keep the role registry. Each role has `name`, `description`, `file`, `t3Role`, a default `isolation`, `readOnly`, and a Claude model with effort. `t3Role` is one of `implementation`, `research`, `review`, `design`, `test`, and `general`. The Claude models copy omp's `modelRoles` and `task.agentModelOverrides`. `reviewer` gets `claude-fable-5-1` at `xhigh`, `scout` gets `claude-sonnet-5-5` at `medium`, `task` gets `claude-sonnet-5-5` at `high`, `sonic` gets `claude-haiku-5-5` at `low`, and every other role gets `claude-opus-5-5` at `high`. A Codex orchestrator's children inherit its model.
- [ ] Port each role body as written. Drop omp-only frontmatter (`tools`, `model`, `spawns`, `thinking-level`), and turn an omp `output` schema into a `Return` section in plain text.
- [ ] In `brief.md`, write the orchestrator brief. It names the board folder by absolute path, the store files and their single writer, the ticket stages, the role registry, the builder cap, and the rule that the user is reached only through `foryou.jsonl` or `request_secret`.
- [ ] Make the brief require that every agent the orchestrator starts is a registry role. A spawn calls `delegate_task` with the role's `t3Role`, its `isolation`, its model as `target`, the title `[<ticket key>] <role name>`, and a task that starts with `Read <board folder>/roles/<role>.md and act as that role.`
- [ ] In `launch.ts`, copy the role files into `<board folder>/roles/`, then start the orchestrator with `orchestration.launchThread`, `workspaceStrategy` `{ type: "root" }`, and the rendered brief as `initialMessage.text`. Save the thread id in `board.json`.
- [ ] In `OrchestratorCard.tsx`, show ticket counts by stage, the open For-you count, builders in use against the cap, and the latest line of `decisions.tsv`.
- [ ] In `OrchestratorPanel.tsx`, stream the orchestrator thread and send messages with `startThreadTurn`.

**You see.**

- [ ] Creating a board starts its orchestrator, the panel streams its first reply, and the orchestrator card appears on the board.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `brief.test.ts` asserts that `renderBrief({ boardDir: "/p/.agentboard/x", builderCap: 2 })` contains that path and the literal text `at most 2 building agents`, and that `orchestratorStats()` counts a fixed ticket list into the expected numbers. Run `vp test run src/orchestrator/brief.test.ts` from `apps/board`.
- [ ] `roles.test.ts` asserts the literal `t3Role`, `isolation`, and Claude model for `task`, `scout`, `reviewer`, `security-reviewer`, and `sonic`, and that every registry `file` exists under `apps/board/roles/`. Run `vp test run src/orchestrator/roles.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have the orchestrator flow, so record that fact. Create a board with Claude Code. Save `b6-claude.png`. Pass when the panel streams a reply and the card shows.
- [ ] Lane 2. Create a board with Codex. Save `b6-codex.png`. Pass when the Codex orchestrator replies.
- [ ] Lane 3. Pick an instance that is signed out. Save `b6-signin.png`. Pass when the sign-in flow starts and the picker shows the signed-in state after it.
- [ ] Lane 4. Send a follow-up in the panel. Save `b6-followup.png`. Pass when the reply streams under the message.
- [ ] Lane 5. Interrupt a running turn. Save `b6-interrupt.png`. Pass when the turn stops and the panel shows it stopped.
- [ ] Lane 6. Reload the app mid-turn. Save `b6-reload.png`. Pass when the panel reattaches and the turn keeps streaming.
- [ ] Lane 7. Ask the orchestrator to plan two tickets and research one of them. Save `b6-store.png`. Pass when `tickets.json`, `decisions.tsv`, and `roles/` appear in the board folder, and the research child's title is `[<key>] scout` with `t3Role` `research`.
- [ ] Lane 8. Read the first message of the orchestrator thread. Save `b6-brief.png`. Pass when it contains the board folder path and the builder cap.
- [ ] Lane 9. Choose a model the instance does not offer. Save `b6-bad-model.png`. Pass when the launch error shows in the dialog.
- [ ] Lane 10. Run the boundary check at head. Save `b6-boundary.txt`. Pass when it exits 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a streamed token arriving on the connection to it rendering in the panel. Trunk does not have the panel, so the budget is absolute and excludes model latency.
- [ ] Probe. Log `board:token-received` and `board:token-painted` marks for 200 tokens of one reply.
- [ ] Baseline. Record that trunk has no panel, then record the head distribution.
- [ ] Rule. The p95 gap stays under 50 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 3, and 7 screenshots into `apps/board/docs/media/b6-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/b6-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B6 to the base-branch stack and the operator lands it bottom-up.

## Show tickets and agents on the board lanes (B7)

**Depends on.** B6.

**Files.**

- [ ] Create `apps/board/src/domain/ticket.ts` and `apps/board/src/domain/ticket.test.ts`.
- [ ] Create `apps/board/src/state/boardModel.ts` and `apps/board/src/state/boardModel.test.ts`.
- [ ] Create `apps/board/src/board/Lanes.tsx`, `apps/board/src/board/TicketFrame.tsx`, and `apps/board/src/board/AgentCard.tsx`.
- [ ] Create `apps/board/src/board/PeekDrawer.tsx`.

**Build.**

- [ ] In `domain/ticket.ts`, define the `tickets.json` schema. A ticket has `key`, `title`, `track`, `dependsOn`, `stage`, `flags`, `branch`, `base`, `worktreePath`, `pr`, `headSha`, `summary`, `why`, `threads` with `threadId`, `role`, and `round`, `verdicts`, and `fixRounds`. `stage` is one of `planned`, `building`, `reviewing`, `verifying`, `pr`, `awaiting_approval`, `merged`, and `off_path`.
- [ ] In `boardModel.ts`, join `tickets.json` with the orchestrator's thread family from `orchestration.getThreadFamily` and the shell. A child no ticket claims goes to an `Unassigned` group.
- [ ] In `Lanes.tsx`, draw the lanes For you, Planned, Building, Reviewing, Verifying, PR and CI, Awaiting approval, Merged, and Off path. A ticket frame sits in the lane of its stage.
- [ ] In `TicketFrame.tsx`, show the key, title, track, the edge to each `dependsOn` ticket, the branch and base, the PR chip, the short head SHA, the fix round count, and verdict chips with P0 to P3 counts. It holds the ticket's agent cards.
- [ ] In `AgentCard.tsx`, show the role name from the title and its registry entry, the provider glyph, the run state from the shell, the pending-request flag, and the worktree branch. Flag a role that is not in the registry.
- [ ] In `PeekDrawer.tsx`, show the ticket's `summary` and `why` as one-liners and a read-only log of the selected agent's thread.
- [ ] Keep frame positions within a lane in local UI state. Only `tickets.json` changes a ticket's stage.

**You see.**

- [ ] A board whose orchestrator planned tickets shows each ticket frame in its lane with its agent cards.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `ticket.test.ts` rejects the stage `done` and names the field. `boardModel.test.ts` joins a fixed ticket list and thread family into literal expected groups, with one orphan child in `Unassigned`. Run `vp test run src/domain/ticket.test.ts src/state/boardModel.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have lanes, so record that fact. Load a fixture `tickets.json` with 19 tickets across every stage. Save `b7-fixture.png`. Pass when each ticket sits in its stage's lane.
- [ ] Lane 2. Have the orchestrator start an owner with `delegate_task`. Save `b7-spawn.png`. Pass when the owner's agent card appears in its ticket frame within 2 s with the `task` role badge.
- [ ] Lane 3. Let that owner finish its turn. Save `b7-idle.png`. Pass when its card shows idle.
- [ ] Lane 4. Write an invalid `tickets.json`. Save `b7-invalid.png`. Pass when the board shows a banner naming the bad field and keeps the last valid layout.
- [ ] Lane 5. Load a fixture with a three-ticket stack. Save `b7-stack.png`. Pass when the dependency edges join the right frames.
- [ ] Lane 6. Open the peek drawer on an agent card. Save `b7-peek.png`. Pass when the one-liners and the read-only log show and the log has no input box.
- [ ] Lane 7. Drag a frame within its lane, then reload. Save `b7-drag.png`. Pass when the frame keeps its new position and its lane.
- [ ] Lane 8. Start a child that no ticket claims. Save `b7-unassigned.png`. Pass when it shows in `Unassigned`.
- [ ] Lane 9. Pan across all nine lanes. Save `b7-pan.png`. Pass when no long task over 50 ms shows in the performance trace.
- [ ] Lane 10. Run the boundary check at head. Save `b7-boundary.txt`. Pass when it exits 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Board render time for 30 tickets with 6 agents each, and the longest task during a pan. Trunk does not have lanes, so the budgets are absolute.
- [ ] Probe. Record five performance traces of the first render and one of a 5 s pan.
- [ ] Baseline. Record that trunk has no lanes, then record the head traces.
- [ ] Rule. The median render stays under 100 ms of scripting, and no pan task exceeds 50 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, and 6 screenshots into `apps/board/docs/media/b7-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/b7-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B7 to the base-branch stack and the operator lands it bottom-up.

## Route everything that needs the user into For-you cards (B8)

**Depends on.** B7.

**Files.**

- [ ] Create `apps/board/src/domain/forYou.ts` and `apps/board/src/domain/forYou.test.ts`.
- [ ] Create `apps/board/src/foryou/actions.ts`.
- [ ] Create `apps/board/src/board/ForYouLane.tsx` and `apps/board/src/board/ForYouCard.tsx`.
- [ ] Edit `apps/board/src/sidebar/Sidebar.tsx` to add the For you count and toast.

**Build.**

- [ ] In `domain/forYou.ts`, define the `foryou.jsonl` item schema. `kind` is one of `merge_approval`, `question`, `ticket_draft`, `gate`, `read`, and `resume`. A `merge_approval` item carries the six merge-ready conditions and its evidence paths.
- [ ] Merge two sources into one list. The first source is `foryou.jsonl`. The second is engine requests from the board's thread family, which are approvals from `pendingRuntimeRequest` and user-only secret requests.
- [ ] In `actions.ts`, resolve a `foryou.jsonl` item by sending the orchestrator a message with the item id and the choice. Show the card as sent until the orchestrator marks it resolved in the file. Resolve engine requests directly with `respondToThreadApproval` and `answerSecretRequest`.
- [ ] Show the open count across all boards in the sidebar, and a toast for each new item.

**You see.**

- [ ] A merge approval card lists the six conditions and its evidence files. Approving it sends the choice to the orchestrator, and the card resolves when the orchestrator records it.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `forYou.test.ts` merges a fixed `foryou.jsonl` and two engine requests into a literal expected order, drops a duplicate id, and skips one invalid line while reporting it. Run `vp test run src/domain/forYou.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have For-you cards, so record that fact. Ask the orchestrator to post a merge approval. Save `b8-merge-card.png`. Pass when the card shows six conditions and evidence links.
- [ ] Lane 2. Approve the lane 1 card. Save `b8-approve.png`. Pass when the orchestrator acknowledges in the panel and the card resolves.
- [ ] Lane 3. Hold a merge approval instead. Save `b8-hold.png`. Pass when the orchestrator records the hold and the card shows held.
- [ ] Lane 4. Answer a question card with one of its options. Save `b8-option.png`. Pass when the orchestrator receives the option text.
- [ ] Lane 5. Answer a question card with free text. Save `b8-free-text.png`. Pass when the orchestrator receives the typed text.
- [ ] Lane 6. Start a child in `approval-required` mode that runs a command. Save `b8-engine-approval.png`. Pass when the approval card shows, approving it resumes the child, and the card leaves the lane.
- [ ] Lane 7. Trigger `request_secret` from the orchestrator. Save `b8-secret.png`. Pass when saving the secret turns the card resolved and the thread shows the secret saved.
- [ ] Lane 8. Add an invalid line to `foryou.jsonl`. Save `b8-invalid-line.png`. Pass when the other cards still show and a banner names the line number.
- [ ] Lane 9. Post items on boards in two projects. Save `b8-count.png`. Pass when the sidebar count equals the total and a toast click opens the right card.
- [ ] Lane 10. Run the boundary check at head. Save `b8-boundary.txt`. Pass when it exits 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a click to the card's sent state, and from a file change to the resolved state. Trunk does not have the cards, so the budgets are absolute.
- [ ] Probe. Log `board:foryou-click`, `board:foryou-sent`, `board:foryou-file-change`, and `board:foryou-resolved` for 20 resolutions.
- [ ] Baseline. Record that trunk has no cards, then record the head distributions.
- [ ] Rule. The click gap p95 stays under 100 ms, and the file gap p95 stays under 2000 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, and 6 screenshots into `apps/board/docs/media/b8-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/b8-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B8 to the base-branch stack and the operator lands it bottom-up.

## Show artifacts on the board (B9)

**Depends on.** B8.

**Files.**

- [ ] Create `apps/board/src/domain/artifact.ts` and `apps/board/src/domain/artifact.test.ts`.
- [ ] Create `apps/board/src/store/artifacts.ts`.
- [ ] Create `apps/board/src/board/ArtifactCard.tsx` and `apps/board/src/artifacts/ArtifactViewer.tsx`.

**Build.**

- [ ] In `domain/artifact.ts`, classify a path into one kind with a lookup table. The kinds are screenshot, proof, script, diff, report, brief, review, plan, design, and decisions. The table keys on the folder (`artifacts/<KEY>/`, `review/<KEY>/`, `inbox/`, or the board root) and the extension.
- [ ] In `store/artifacts.ts`, list the board folder with `projects.listEntries` and attach each artifact to its ticket key, or to the orchestrator for board-level files.
- [ ] In `ArtifactCard.tsx`, show a count on each ticket frame that expands into cards. Board-level artifacts attach to the orchestrator card.
- [ ] In `ArtifactViewer.tsx`, show images through an `assets.createUrl` `media-file` URL, render markdown and text through `projects.readFile`, and show a ticket's `README.txt` as a list of files and what each proves.

**You see.**

- [ ] Each ticket frame shows its artifact count, and opening a card shows the screenshot, proof, or report inside the app.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `artifact.test.ts` classifies twelve fixed paths, taken from the XEO-3330 evidence layout, into literal expected kinds and ticket keys. Run `vp test run src/domain/artifact.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have artifact cards, so record that fact. Load a fixture board folder with 300 files. Save `b9-fixture.png`. Pass when each ticket frame shows the right count.
- [ ] Lane 2. Open a screenshot card. Save `b9-image.png`. Pass when the image renders from a signed URL.
- [ ] Lane 3. Open a markdown report. Save `b9-markdown.png`. Pass when the headings and lists render.
- [ ] Lane 4. Open a ticket's `README.txt`. Save `b9-readme.png`. Pass when each file shows next to what it proves.
- [ ] Lane 5. Open a binary file. Save `b9-binary.png`. Pass when the viewer shows a binary placeholder.
- [ ] Lane 6. Have an agent write a new proof file. Save `b9-new-file.png`. Pass when the count rises within 3 s.
- [ ] Lane 7. Open a 5 MB text file. Save `b9-large.png`. Pass when the viewer shows the truncated notice.
- [ ] Lane 8. Open `design.md` from the orchestrator card. Save `b9-design.png`. Pass when it renders.
- [ ] Lane 9. Open an artifact that lives in a ticket worktree by absolute path. Save `b9-worktree.png`. Pass when it renders.
- [ ] Lane 10. Run the boundary check at head. Save `b9-boundary.txt`. Pass when it exits 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to list and classify 300 files, and the number of images loaded before scrolling. Trunk does not have artifacts, so the budgets are absolute.
- [ ] Probe. Log `board:artifacts-listed` five times and count image requests in the network log.
- [ ] Baseline. Record that trunk has no artifacts, then record the head numbers.
- [ ] Rule. The median list time stays under 500 ms, and only visible thumbnails load.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, and 4 screenshots into `apps/board/docs/media/b9-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/b9-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B9 to the base-branch stack and the operator lands it bottom-up.

## Track pull requests, CI, and merge readiness per ticket (B10)

**Depends on.** B9.

**Files.**

- [ ] Create `apps/board/src/state/prStatus.ts`.
- [ ] Create `apps/board/src/domain/readiness.ts` and `apps/board/src/domain/readiness.test.ts`.
- [ ] Create `apps/board/src/board/PrChip.tsx` and `apps/board/src/board/ReadinessChecklist.tsx`.

**Build.**

- [ ] In `prStatus.ts`, find each ticket's PR from `tickets.json` or the owner thread's `pullRequests`, and read checks with `pullRequests.checks`.
- [ ] In `domain/readiness.ts`, compute the six merge-ready conditions from the ticket's verdicts, its fix rounds, the parent ticket's state, its evidence paths, and live CI. Flag a check that has run longer than 20 minutes as stuck.
- [ ] In `PrChip.tsx`, show the PR number, state, checks state, and mergeability on the ticket frame.
- [ ] In `ReadinessChecklist.tsx`, show each condition as met or missing in the peek drawer and on merge approval cards.

**You see.**

- [ ] Each ticket frame shows its PR and CI state, and the checklist shows which merge-ready conditions are still missing.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `readiness.test.ts` asserts the literal missing-condition list for four fixed tickets, and that a check running 21 minutes is stuck while one running 19 minutes is not. Run `vp test run src/domain/readiness.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have PR tracking, so record that fact. Point a ticket at a scratch PR on `13kparkin/t3code`. Save `b10-pr-chip.png`. Pass when the chip shows the PR number and state.
- [ ] Lane 2. Push a commit that fails the scratch PR's check. Save `b10-ci-red.png`. Pass when the chip turns red within 5 s of the shell update.
- [ ] Lane 3. Push a fix. Save `b10-ci-green.png`. Pass when the chip turns green.
- [ ] Lane 4. Open the peek drawer. Save `b10-checks.png`. Pass when each check shows with its result.
- [ ] Lane 5. Give a ticket a verdict with an unresolved P1. Save `b10-checklist-missing.png`. Pass when the reviews condition shows missing.
- [ ] Lane 6. Make every condition true for a ticket. Save `b10-checklist-ready.png`. Pass when all six show met.
- [ ] Lane 7. Leave a check running 21 minutes in a fixture. Save `b10-stuck.png`. Pass when the chip shows stuck.
- [ ] Lane 8. Stack a child PR on a parent that is not merged. Save `b10-parent.png`. Pass when the parent condition shows missing on the child.
- [ ] Lane 9. Merge the scratch PR. Save `b10-merged.png`. Pass when the chip shows merged.
- [ ] Lane 10. Run the boundary check at head. Save `b10-boundary.txt`. Pass when it exits 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a shell stream event that changes a PR to the chip update. Trunk does not have PR tracking, so the budget is absolute.
- [ ] Probe. Log `board:pr-event` and `board:pr-painted` for 20 changes.
- [ ] Baseline. Record that trunk has no PR tracking, then record the head distribution.
- [ ] Rule. The p95 gap stays under 250 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, and 6 screenshots into `apps/board/docs/media/b10-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/b10-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B10 to the base-branch stack and the operator lands it bottom-up.

## Add the browser panel (B11)

**Depends on.** B10.

**Files.**

- [ ] Create `apps/board/electron/browserView.ts`.
- [ ] Create `apps/board/src/browser/BrowserPanel.tsx`, `apps/board/src/browser/tabs.ts`, and `apps/board/src/browser/tabs.test.ts`.
- [ ] Create `apps/board/src/browser/AgentTabView.tsx`.

**Build.**

- [ ] In `browserView.ts`, host user tabs in an Electron `WebContentsView` beside the board, with back, forward, reload, and an address bar driven over IPC.
- [ ] In `tabs.ts`, keep the tab list in a reducer with open, close, and activate actions.
- [ ] In `AgentTabView.tsx`, list the engine's browser tabs with `preview.list` and show one through the `/api/preview-stream/ws` stream with a media ticket.
- [ ] Open PR links, artifact links, and local preview URLs from cards in the panel.

**You see.**

- [ ] The sidebar **Browser** item opens a panel beside the board, and a PR chip opens its PR in a tab there.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tabs.test.ts` runs open, open, close, and activate against the reducer and asserts the literal tab list and active id after each. Run `vp test run src/browser/tabs.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have the panel, so record that fact. Open the panel in the Electron app. Save `b11-open.png`. Pass when the panel shows beside the board.
- [ ] Lane 2. Click a PR chip. Save `b11-pr.png`. Pass when the PR page loads in a new tab.
- [ ] Lane 3. Type a URL and press Enter. Save `b11-url.png`. Pass when the page loads and the address bar shows it.
- [ ] Lane 4. Use back and forward. Save `b11-history.png`. Pass when each moves one page.
- [ ] Lane 5. Close a tab. Save `b11-close.png`. Pass when the next tab becomes active.
- [ ] Lane 6. Have an agent open an engine browser tab. Save `b11-agent-tab.png`. Pass when it shows in the agent tab list and its stream renders.
- [ ] Lane 7. Open a local preview URL from an artifact card. Save `b11-preview.png`. Pass when it loads.
- [ ] Lane 8. Resize the panel. Save `b11-resize.png`. Pass when the page reflows and the board stays usable.
- [ ] Lane 9. Open web dev mode, which has no Electron. Save `b11-web-mode.png`. Pass when the panel shows the agent tab list and offers to open links in the system browser.
- [ ] Lane 10. Run the boundary check at head. Save `b11-boundary.txt`. Pass when it exits 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from clicking **Browser** to the panel's first paint. Trunk does not have the panel, so the budget is absolute.
- [ ] Probe. Log `board:browser-click` and `board:browser-painted` ten times.
- [ ] Baseline. Record that trunk has no panel, then record the head times.
- [ ] Rule. The median stays under 500 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, and 6 screenshots into `apps/board/docs/media/b11-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/b11-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B11 to the base-branch stack and the operator lands it bottom-up.

## Port the omp skills for T3 agents (B12)

**Depends on.** B11.

**Files.**

- [ ] Create `apps/board/skills/ponytail/SKILL.md`, `apps/board/skills/pre-pr-reviewer/SKILL.md`, and `apps/board/skills/simplify/SKILL.md`.
- [ ] Create `apps/board/skills/orchestrate/SKILL.md`.
- [ ] Create `apps/board/scripts/install-skills.mjs` and `apps/board/scripts/install-skills.test.mjs`.
- [ ] Edit `apps/board/src/orchestrator/brief.md` to point at the `orchestrate` skill.

**Build.**

- [ ] Port `ponytail`, `pre-pr-reviewer`, and `simplify` from omp as Claude Code and Codex skills, per `skill://poteto-mode/playbooks/authoring-a-skill.md`.
- [ ] Write the `orchestrate` skill from the omp orchestrate and autopilot-stack playbooks, rewritten for T3's `delegate_task`, `t3_thread_*`, and `request_secret` tools, the board store contract, and the B6 role registry.
- [ ] In the `orchestrate` skill, map each lifecycle step to a registry role. The ticket owner is `task` or `poteto-agent` with `worktree` isolation. The owner spawns its reviewers (`reviewer`, `security-reviewer`, `comment-sicko`, and `thermo-nuclear-review-subagent`) with `shared` isolation, so they read the ticket's worktree. Research is `scout`, mechanical edits are `sonic`, and document reviews are the `egm-*` roles. A fix round goes to the owner thread with `t3_thread_send`, not to a new agent.
- [ ] In `install-skills.mjs`, link each skill folder into `~/.claude/skills/` and the Codex skills folder, and skip links that already point there.
- [ ] Also turn on Codex memories in `~/.codex/config.toml`, with `[features] memories = true` and `memories.disable_on_external_context = false`, because every T3 thread uses the T3 MCP server. Leave every other key as it is.

**You see.**

- [ ] `node apps/board/scripts/install-skills.mjs` links four skills, and a T3 Claude thread lists them in its provider skills.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `install-skills.test.mjs` runs the script against a temporary home. The first run creates four links, the second run reports four skipped links, and a link that points elsewhere is reported and left alone. Run `node --test apps/board/scripts/install-skills.test.mjs`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have the skills, so record that fact. Run the install script at head. Save `b12-install.txt`. Pass when four links exist in `~/.claude/skills/`.
- [ ] Lane 2. Run the install script again. Save `b12-reinstall.txt`. Pass when it reports four skipped links and changes nothing.
- [ ] Lane 3. Read the provider skills for the Claude instance from the server config. Save `b12-claude-skills.txt`. Pass when all four skills are listed.
- [ ] Lane 4. Read the provider skills for the Codex instance. Save `b12-codex-skills.txt`. Pass when all four skills are listed.
- [ ] Lane 5. Start a board orchestrator and ask it to plan two tickets. Save `b12-plan.txt`. Pass when `tickets.json` follows the board schema.
- [ ] Lane 6. Let the orchestrator start one ticket. Save `b12-owner.txt`. Pass when the owner's title is `[<key>] task`, its role is `implementation`, and it runs in a new worktree.
- [ ] Lane 7. Let the owner reach code-ready. Save `b12-review.txt`. Pass when a child titled `[<key>] reviewer` runs with role `review` in the owner's checkout and its thread shows no file edit.
- [ ] Lane 8. Ask an agent to apply ponytail on a small change. Save `b12-ponytail.txt`. Pass when the agent's reply ends with the skipped and risk lines.
- [ ] Lane 9. Run two T3 Codex threads in the same project, where the first states a project fact. Save `b12-codex-memory.txt`. Pass when `~/.codex/memories_v2/` holds that fact after the first thread goes idle, or record the gap if Codex never writes it.
- [ ] Lane 10. Run the boundary check at head. Save `b12-boundary.txt`. Pass when it exits 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of the install script. Trunk does not have it, so the budget is absolute.
- [ ] Probe. Run `time node apps/board/scripts/install-skills.mjs` five times.
- [ ] Baseline. Record that trunk has no script, then record the head times.
- [ ] Rule. The median stays under 1 s.

**Review gate.** None. B12 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B12 to the base-branch stack and the operator lands it bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

The UI design was settled with a throwaway HTML prototype at `/home/kyle/personalDev/main/artifacts/agent-board-prototype/`. That folder is not a git repository, so there is no branch or SHA. The evidence is these files.

- `round1-layouts.html` compares three board layouts. The operator picked layout B, lanes on a dotted board.
- `index.html` holds round 2, with For-you items written only by the orchestrator and three chat layouts.
- `shots/r2/b-dark.png` is the approved look, layout B in dark mode.
- `moodboard.html` and `refs/refs.json` hold 11 references.

The engine questions were answered from source by two read-only scouts against commit `80cf4f7945`, with file pointers.

- Every thread gets the orchestrator MCP tools, and an orchestrator is a normal thread started with a brief (`apps/server/src/orchestration-v2/ProviderSessionManager.ts`).
- `delegate_task` children carry `lineage.parentThreadId`, and `isolation: 'worktree'` starts the child from the parent checkout's HEAD (`apps/server/src/mcp/OrchestratorMcpService.ts`).
- Child approvals reach only the user. Child questions reach the parent and the user (`apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts`, `packages/client-runtime/src/state/threadShell.ts`).
- Archiving a parent does not archive `delegate_task` children (`apps/server/src/orchestration-v2/Orchestrator.ts`).
- `projects.readFile` and `assets.createUrl` with `media-file` accept absolute paths (`apps/server/src/workspace/WorkspaceFileSystem.ts`, `apps/server/src/assets/AssetAccess.ts`).
- `delegate_task` takes `task`, `target` (provider instance, model, effort options), `title`, `role`, and `isolation`, and `role` is a fixed list of six (`packages/contracts/src/orchestratorMcp.ts:140`, `:171`). It has no field for a system prompt, so an omp role travels as the first line of `task` plus the role's `target`.
- omp has no user-level roles. `~/.omp/agent/agents` links to a folder that does not exist (measured). The 18 active roles come from omp's bundle and the pstack-omp, thermos-omp, and egm plugins.

The agent capabilities were answered by five read-only scouts, with reports in the root session's `local://` store.

- T3's Claude threads pass no `settingSources`, so the Agent SDK loads user, project, and local settings. `~/.claude/settings.json` hooks, enabled plugins, skills, and Claude Code's own project memory apply (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `makeClaudeQueryOptions`). An instance with a custom `CLAUDE_CONFIG_DIR` reads that folder instead.
- Claude Code hooks can deny a tool call with a reason (PreToolUse), add context after a call (PostToolUse `additionalContext`), add context to a prompt (UserPromptSubmit), and force another turn (Stop `decision: "block"`). No hook sees the reply while it streams, so omp's mid-reply interrupt becomes an end-of-turn check.
- omp matches rules only against streamed assistant text, thinking, and tool-call arguments, once per session per rule. None of the 26 rules uses `astCondition`. omp shows LSP diagnostics after writes but never runs oxlint itself.
- T3 already gives agents parallel children with no engine cap, worktree isolation, session resume, and `preview_*` browser tools for Claude and Codex (`apps/server/src/mcp/toolkits/preview/tools.ts`).
- Claude Code's LSP tool needs a plugin that names a server. Codex has no LSP. Claude Code keeps cwd but not env vars between Bash calls, and sources `CLAUDE_ENV_FILE` before each one.
- Under Vite+, oxlint ignores nested lint configs, so the repo standards run through an explicit `-c` config (`node_modules/vite-plus/docs/guide/lint.md`). ZAIkai fails only diagnostics on added lines (`scripts/check-oxlint-diff.mjs`), which lets standards cover a repo with existing debt.

These stay unproven until B3 runs.

- Whether `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` from `~/.claude/settings.json` reaches a T3 Claude thread.
- Whether `projects.listEntries` accepts an absolute `directoryPath`.
- Whether the `/api/assets/` route needs an auth header.
- Whether nested `delegate_task` works end to end with a real provider.
- Whether Claude Code's own project memory works inside a T3 Claude thread, and whether `preview_*` works with no client connected.

## Appendix B. Alternatives rejected

- Editing T3's `apps/web` and `apps/desktop` lost, because T3 changes them faster than we could merge, and every upstream pull would conflict.
- Bundling the engine inside our app lost, because engine updates would then wait on our releases. T3's own background service updates itself.
- Storing boards in the engine lost, because it needs an engine change.
- Storing boards in `~/.agentboard` lost, because `projects.writeFile` writes only inside a project. Boards live in `<project>/.agentboard/<slug>/` with a self-ignoring `.gitignore`.
- Layouts A (free board) and C (orchestrator hub) lost to layout B in the prototype.
- A per-session "needs you" state lost, because the operator works only through the orchestrator. Sessions show `Waiting on you` and point at a For-you item.
- `create_threads` for agents lost, because its threads have no lineage. Agents start with `delegate_task`.
- Installing the omp roles as Claude Code subagents in `~/.claude/agents/` lost, because those run inside one thread, so the board could not show them as cards and Codex could not use them.
- DPoP auth lost to bearer tokens from `t3 auth session issue`, because the engine runs on the same machine.
- Editing T3's root `vite.config.ts` lint block lost, because every upstream merge could conflict there. The standards live in a new `standards/` folder and run with their own config.
- A lint config nested in `apps/board` lost, because Vite+ turns nested configs off.
- Copying the omp rules into the plugin lost to reading `~/.omp/agent/rules` at hook time, so omp and Claude Code share one rule set.
- Hindsight memory lost by operator choice. Claude Code's own project memory and Codex memories cover cross-session memory with no new service.
- Claude in Chrome lost, because Claude Code does not support it in WSL. Agents use T3's `preview_*` tools.
- A persistent code kernel MCP and an LSP MCP for Codex were left out, because neither was asked for by name and each adds a service to own.
- The dock and per-card chat layouts are deferred. B6 ships the side panel, and the operator revises the chat while using it.

## Appendix C. Risks

- `packages/client-runtime` has no stable API. An upstream merge can break the board build. Every owner runs `vp run --filter @agent-board/app typecheck` after merging upstream, and the fix always lands in `apps/board`.
- Electron lanes run on the Windows PC and depend on WSL's mirrored networking, which `.wslconfig` sets today. If it changes to NAT, the app can't reach the WSL engine or Vite server on 127.0.0.1, and the lanes fail until it is set back.
- T3 desktop starts its own WSL backend on `~/.t3` and may not join one the board booted. Two engines on one state folder would fight over `state.sqlite`. B2 lane 7 proves the board joins T3 desktop's engine. If T3 desktop launched second also starts its own, the board stops its child and joins T3 desktop's engine.
- B4's update lanes need systemd user services in WSL. If they are missing, B4 records the gap and proves the update path on a machine that has them.
- CLI sessions from `t3 auth session issue` never renew. B2 mints a new token on the first 401.
- The orchestrator can write a malformed store file. B5, B7, B8, and B9 parse every file at the boundary, keep the last valid state, and show a banner.
- T3 cannot limit a child's tools. Read-only roles such as `scout`, `reviewer`, and `security-reviewer` stay read-only only because their role file says so. B12 lane 7 reads the reviewer child's thread and fails when it shows an edit.
- Lanes in B3, B6, B8, and B12 use the operator's Claude Code and Codex subscriptions, which costs usage. Run them once per head.
- Lanes never touch `~/.t3`. Each lane uses its own `--base-dir`.
- GitHub Actions are off by default on a fork. The operator enables them for `13kparkin/t3code` before B0's lane 10.
- Auto-compaction in `~/.claude/settings.json` was switched from `false` to `true` with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` set to `60`. Every Claude Code session on this machine now compacts at 60% of its auto-compact window.
- T3 Codex threads get no omp rules and no lint hooks, because the operator scoped both to Claude Code. CI and the pre-push hook still check Codex's commits.
- Upstream could add its own `.claude/settings.json` or `.vite-hooks/pre-push` later. The boundary check would then flag S1's copy as an edit to an upstream file, and the owner merges the two by hand.
- `vp lint -c` skipping the root lint block is read from docs, not run. S1's first build box proves it or switches to the bundled oxlint binary.

## Appendix D. Links and reading list

- Read `docs/internals/overview.md`, `docs/internals/connection-runtime.md`, `docs/internals/environment-auth.md`, `docs/internals/server-updates.md`, and `docs/orchestration-v2/orchestrator-mcp-server.md` before editing.
- Read `apps/mobile/src/connection/platform.ts` and `runtime.ts` before B2, because a non-browser client builds its connection the same way.
- Read the XEO-3330 store at `~/.omp/agent/sessions/-orca-workspaces-ZAIkai-xeo-3330-claude-plugin-for-xeo-360-internal/2026-11-16T09-48-05-426Z_01a1e3c1-b5b2-7191-a328-3bc18f192302/local/orchestrate/xeo-3330/` before B6, B7, B8, and B12. Its `preferences.md`, `units.tsv`, `gates.md`, and `decisions.tsv` are the model for the board store.
- B2, B6, and B7 get `skill://how` before code and `skill://architect` for the shapes that cross function boundaries. B6 and B8 get `skill://interrogate`, because the brief contract and the For-you resolution path are the contested designs.
- The root keeps the decision trail per `skill://show-me-your-work` in `apps/board/docs/decisions.tsv`.
