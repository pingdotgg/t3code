# Agent Board build plan

Agent Board is a desktop app for running projects through an orchestrator on the T3 Code engine. The sidebar lists T3 projects, each project lists its boards, and each board shows one orchestrator, its tickets in lanes, the agents working each ticket, artifact cards, and For-you cards. The workflow it shows is the XEO-3330 run from November 2026.
The rule the program enforces is that the engine stays upstream. No PR edits a file that exists upstream, except `pnpm-lock.yaml`. Every PR passes `apps/board/scripts/check-engine-untouched.mjs`. The repo's lint and dependency standards apply to every file in the repo, and fail only on lines we add or change.
The PRs, in stack order, are B0, B1, S1, K1, B2, U1, B3, W1, B4, B5, B6, B7, C1, B8, B9, B10, B11, W2, R1, K2, C2, F1, D1, M1, L1, B12, R2, A1, P1, G1, O1, X1, and Y1.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `skill://poteto-mode/playbooks/autopilot-stack.md`. The operator granted standing merge approval. Wherever this plan says the operator lands a PR, the root merges it bottom-up with a merge commit once its verdict is clean, retargets the next PR to `main`, and keeps every remote branch.

Speed comes last, by the operator's call. Each PR still runs its perf probe and records the numbers, which checks its perf boxes. A missed perf rule never blocks a merge. O1 fixes every miss recorded before it. X1 and Y1 come after O1, by the operator's call, so each fixes its own misses the way O1 does before it merges.

The board is a UI over T3's engine. Every feature drives a capability T3 already has, and a PR that needs one T3 lacks stops and reports it instead of building engine logic in the board. Screens take their layout and components from Orca, drawn in the board's T3 dark tokens. The board reaches T3 through `@t3tools/contracts` and `@t3tools/client-runtime/<subpath>`, and from C2 on also through `@t3tools/shared/<subpath>`. It never imports from `apps/*` or `packages/*/src`, so a T3 web component is copied as a pattern, never imported.

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
  - [ ] B1 after B0. S1 after B1. K1 after S1. B2 after K1. U1 after B2. B3 after U1. W1 after B3. B4 after W1. B5 after B4. B6 after B5.
  - [ ] B7 after B6. C1 after B7. B8 after C1. B9 after B8. B10 after B9. B11 after B10. W2 after B11. R1 after W2. K2 after R1. C2 after K2. F1 after C2. D1 after F1. M1 after D1. L1 after M1. B12 after L1. R2 after L1. A1 after L1. P1 after R2 and A1. G1 after P1. O1 after B12 and G1. X1 after O1. Y1 after O1.
- [ ] Hold the file boundaries. Every PR touches only `apps/board/**`, `.github/workflows/agent-board.yml`, and `pnpm-lock.yaml`. S1 also adds `standards/**`, `.vite-hooks/pre-push`, and `.claude/settings.json`, which upstream does not have. K1 and B12 write outside the repo only through their install scripts, and B12 and R2 also edit the separate `13kparkin/pstack-t3` repo.
- [ ] Hold the review gate. B1, B2, U1, W1, B4, B5, B6, B7, C1, B8, B9, B10, B11, W2, R1, C2, F1, D1, M1, L1, R2, A1, P1, X1, and Y1 change an interaction. They post their screenshots and video in chat at merge, so the operator can ask for a follow-up PR.
- [ ] Cap building agents at 2 at once, and run a push as the only heavy job, because this machine has 15 GB of RAM and 4 cores.

### PR mechanics, for every PR

- [ ] Resolve the repository forge once. Use `gh` against `13kparkin/t3code`, which is the configured forge for this fork. Record that choice in the decision trail.
- [ ] Open the PR ready, never draft, with the configured forge's create command, per `skill://poteto-mode/playbooks/opening-a-pr.md`. A stack child targets its parent branch.
- [ ] Run lint and typecheck once before the PR-facing push, as `vp lint apps/board` and `vp run --filter @agent-board/app typecheck`. From S1 on, also run `node standards/check-added-diagnostics.mjs`. Push with hooks on.
- [ ] Before the code-ready push, run the author checks in `skill://review-loop`, with the PR's plan section as the ticket.
- [ ] A docs-only PR, such as a plan change, runs `skill://unslop` on its changed sections instead, and applies what it finds.
- [ ] Triage every Bugbot and security-reviewer comment per `skill://poteto-mode/references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, or on a CI failure that comes from a change on trunk.
- [ ] Run `node apps/board/scripts/check-engine-untouched.mjs` before every push. A non-zero exit blocks the push.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `skill://swarm`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. The reviewer lanes from `skill://review-loop`, which read the diff and the receipts and distrust the PR body.
- [ ] The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings and fix rounds follow `skill://review-loop`: a finding needs a concrete failing case, the owner applies the smallest fix, the same lanes run again at the new head, and after two fix rounds the root asks the operator. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `skill://poteto-mode/playbooks/shipping.md`.
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
- [ ] Never create a GitHub repo for a lane. A lane that needs a real PR, issue, or CI run uses the one private repo `13kparkin/agent-board-lanes`, on branches named `lane/<pr-id>/<n>/...`. Close the lane's PRs and issues and delete its branches when the lane ends. Run its CI on a local self-hosted runner. Copy only `bin/`, `config.sh`, `env.sh`, `run.sh`, `externals/`, and the `run-helper*` templates from `~/.local/share/shortyard-runner/linux-1`, never its credential files. Register the copy to `agent-board-lanes` with the label `board-lane-<pr-id>` only, and set `runs-on: [self-hosted, board-lane-<pr-id>]` in the workflow file of every `lane/<pr-id>/...` branch, because two lanes sharing one label take each other's jobs. Unregister the runner and delete its copy, credential files included, when the lane ends.

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
- [ ] In `Sidebar.tsx`, render the empty Projects section and a footer slot.
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

## Join T3's engine in WSL and list its projects (B2)

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
- [ ] In `engine.ts`, reach T3's own engine, never a copy the board runs. That engine is T3's background service in WSL, the same `t3` server T3 desktop runs, with no UI. T3 keeps it updated through `t3 update`. Find it in this order, so installing the app is enough to reach the WSL dev environment.
  - [ ] `AGENT_BOARD_ENGINE_URL`, when set.
  - [ ] Join a running engine. Read `~/.t3/userdata/server-runtime.json` in the distro, and use its `origin` when its `pid` is alive and the origin answers. `AGENT_BOARD_T3_HOME` overrides `~/.t3` for lanes.
  - [ ] Start the service. When `t3` is installed and current but the service is stopped or missing, run `t3 service install`, which also repairs a broken service, then join.
  - [ ] Install T3. When `t3` is missing, ask once, then run T3's install script (`curl -fsSL https://t3.codes/install.sh | sh`) and `t3 service install` inside WSL, then join.
  - [ ] Update T3. When `t3` or the running engine is older than this client accepts, by the rule in `@t3tools/client-runtime/connection`, ask once, then run `t3 update --yes`, then join.
- [ ] Keep WSL running while the app is open. Hold one idle `wsl.exe` process for the distro, and end it on quit, so WSL does not shut down under the service. Never stop the service itself.
- [ ] Mint a bearer with that runtime's `auth session issue --token-only --label agent-board --ttl 30d` through `wslEngine.ts`. `AGENT_BOARD_T3_CLI` overrides the command. Store the token with Electron `safeStorage`. On a 401, mint a new token once, then surface `auth_failed`.
- [ ] In `platform.ts` and `runtime.ts`, build the connection runtime the way `apps/mobile/src/connection/platform.ts` and `runtime.ts` do, with a bearer target registered through `ConnectionOnboarding`.
- [ ] In `state/projects.ts`, read projects with `createEnvironmentProjectAtoms`. `ProjectList.tsx` lists them.
- [ ] In `EngineStatus.tsx`, show the phase, as `Engine connected`, `Starting T3 in WSL`, `Installing T3 in WSL`, `Updating T3 in WSL`, `Connecting`, or `Offline` with the reason.

**You see.**

- [ ] On a fresh launch, the app finds or starts T3's service in WSL, and the sidebar lists the projects from that environment.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `engine.test.ts` uses a fake `wsl.exe` runner and a fake fetch. It asserts the discovery order, that a stale `server-runtime.json` (dead `pid`) leads to `t3 service install`, that an old `t3` leads to the update prompt, that the app never stops the service, exactly one reissue on the first 401, and the `auth_failed` error on the second 401. Run `vp test run electron/engine.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have the app, so record that fact. Seed three projects in the lane engine and open the head app. Save `b2-regression.png`. Pass when the sidebar lists the three seeded project names.
- [ ] Lane 2. Stop the lane service, then start the Windows app. Save `b2-start-service.png`. Pass when the footer shows `Starting T3 in WSL`, then `Engine connected` within 15 s, and `t3 service status` reports it running.
- [ ] Lane 3. Quit the app after lane 2. Save `b2-quit.txt`. Pass when the service is still running and the app's idle `wsl.exe` process is gone.
- [ ] Lane 4. Revoke the lane token with `auth session revoke`. Save `b2-reissue.png`. Pass when the app logs one reissue and reconnects.
- [ ] Lane 5. Add a project through the engine CLI while the app runs. Save `b2-add-project.png`. Pass when the project appears within 2 s.
- [ ] Lane 6. Archive a project through the engine. Save `b2-archive-project.png`. Pass when the project leaves the list within 2 s.
- [ ] Lane 7. Give the lane only T3 desktop's old `0.0.30` runtime and an old `t3`. Save `b2-update.png`. Pass when the app asks to update T3, and a decline leaves `Offline` with the found version and nothing changed.
- [ ] Lane 8. Point `AGENT_BOARD_T3_HOME` at an empty folder with no `t3` on the `PATH`. Save `b2-install.png`. Pass when the app asks before installing, and a decline leaves the footer on `Offline` with the reason.
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

## Style the sidebar like Orca's and add the usage bar (U1)

**Depends on.** B2.

**Files.**

- [ ] Create `apps/board/src/sidebar/SidebarRow.tsx`, `apps/board/src/sidebar/CountChip.tsx`, and `apps/board/src/sidebar/ProjectHeader.tsx`.
- [ ] Create `apps/board/src/sidebar/AddProject.tsx` and `apps/board/electron/pickFolder.ts`.
- [ ] Edit `apps/board/src/sidebar/Sidebar.tsx` and `apps/board/src/sidebar/ProjectList.tsx` to use them.
- [ ] Create `apps/board/src/usage/UsageBar.tsx`, `apps/board/src/usage/usage.ts`, and `apps/board/src/usage/usage.test.ts`.
- [ ] Edit `apps/board/src/App.tsx` to place the usage bar along the bottom of the window.

**Build.**

- [ ] Match the rows in Orca's sidebar, shown in `/home/kyle/personalDev/main/artifacts/agent-board-prototype/refs/orca-sidebar.png`. That means a section header with small icon buttons, a project header with its mark, bold name, chevron, menu, and add button, and compact rows with a leading icon, a truncated title, and trailing status icons. Nested rows indent one step per level. A count chip shows a child count, a green status dot with its count, and a chevron. A pill row stands for hidden items, and the footer holds settings and help icons. Keep the sidebar's current width, colors, and T3 dark tokens, and change only the rows.
- [ ] Build the rows and chips as one shared set, so B5's board rows and B7's agent tree reuse them.
- [ ] Add projects from the sidebar. The `+` in the Projects header opens a folder picker that starts at `\\wsl.localhost\<distro>\home\<user>`, converts the choice to a WSL path with `wslpath -u` through `wslEngine.ts`, and creates the project with `createProject` from `@t3tools/client-runtime/operations/commands`. A typed WSL path works too. A folder that is missing, outside WSL, or already a project shows the reason inline.
- [ ] In `UsageBar.tsx`, draw a bar under both the sidebar and the canvas, as Orca does. It starts with `Used`, then shows each signed-in provider's glyph, its session or weekly window as a used percent with time to reset, and its model windows, such as `3% Fable`. Read the windows from the engine's server config, `providers[].usageLimits` (`packages/contracts/src/providerUsageLimits.ts`, `packages/contracts/src/server.ts:296`), so T3 does the probing. Never call Anthropic or OpenAI from the board. When `unavailable` is set, show a dash with the reason in a tooltip.
- [ ] In `usage.ts`, turn windows into bar text. Round percents, print the time to reset as `5d 22h`, or as minutes under an hour, and put the session window before the weekly one and model windows last.

**You see.**

- [ ] The sidebar rows look like Orca's, the Projects header's `+` adds a project from a WSL folder, and a bar along the bottom of the window reads like `Used ✳ 8% 5d 22h · 3% Fable` for Claude Code, followed by Codex.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `usage.test.ts` formats fixed windows into literal text. A session window at 8% that resets in 5 days 22 hours gives `8% 5d 22h`. A Fable window at 3% gives `3% Fable`. A reset 40 minutes out gives `40m`. An `unavailable` limit gives the dash and its reason. Run `vp test run src/usage/usage.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open trunk and head against a lane engine with three projects. Save `u1-trunk.png` and `u1-sidebar.png`. Pass when the head rows match the Orca reference layout and trunk shows the plain list.
- [ ] Lane 2. Run the Windows app. Save `u1-windows.png` from a full-window capture. Pass when the usage bar spans the bottom under both the sidebar and the canvas.
- [ ] Lane 3. Use a lane engine with the operator's Claude Code login. Save `u1-claude.png` and the engine's `usageLimits` JSON as `u1-claude.json`. Pass when the bar text equals `usage.ts` applied to that JSON.
- [ ] Lane 4. Repeat lane 3 with a Codex instance. Save `u1-codex.png` and `u1-codex.json`. Pass when the Codex section matches its JSON.
- [ ] Lane 5. Use a provider instance that is signed out. Save `u1-unavailable.png`. Pass when its section shows the dash and the tooltip gives the reason.
- [ ] Lane 6. Run one Claude turn while the app is open. Save `u1-live.txt`. Pass when the bar changes within 2 s of the server config event that carries new limits, with no reload.
- [ ] Lane 7. Add a project with a 90-character name. Save `u1-truncate.png`. Pass when the title ends in an ellipsis and the trailing icons stay visible.
- [ ] Lane 8. Hover a row, Tab through the rows, then collapse and expand a project header. Save `u1-focus.png`. Pass when hover and focus each show a visible state, and the collapsed state survives a reload.
- [ ] Lane 9. Click `+` in the Projects header, pick a WSL folder, then try `C:\Users`. Save `u1-add-project.png`. Pass when the WSL folder appears as a project within 2 s, and `C:\Users` shows the outside-WSL reason with no project created.
- [ ] Lane 10. Run the boundary check and the standards check at head. Save `u1-checks.txt`. Pass when both exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Sidebar commit time with 50 projects. Trunk renders the plain list, so the budget is absolute.
- [ ] Probe. Record a React profiler trace of the first sidebar render five times at trunk and at head.
- [ ] Baseline. Record the trunk numbers first.
- [ ] Rule. The head median stays under 50 ms, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 1, 2, and 3 screenshots into `apps/board/docs/media/u1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/u1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends U1 to the base-branch stack and the operator lands it bottom-up.

## Probe the engine behaviors the board depends on (B3)

**Depends on.** U1.

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

## Add an Orca-style settings screen with worktree setup and cleanup (W1)

**Depends on.** B3.

**Files.**

- [ ] Create `apps/board/src/settings/SettingsScreen.tsx` and `apps/board/src/settings/SettingsNav.tsx`.
- [ ] Create `apps/board/src/settings/WorktreesPage.tsx` and `apps/board/src/settings/CleanupPage.tsx`.
- [ ] Create `apps/board/src/settings/settingsModel.ts` and `apps/board/src/settings/settingsModel.test.ts`.
- [ ] Edit `apps/board/src/sidebar/Sidebar.tsx` so the footer's settings icon opens the screen.

**Build.**

- [ ] In `SettingsScreen.tsx`, lay the screen out like Orca's settings, with a category list on the left, the selected page on the right, and a back control. Use U1's rows and the board's T3 dark tokens.
- [ ] In `WorktreesPage.tsx`, edit T3's own worktree settings for the environment, with a per-project override, the way T3's Settings, then Worktrees page does. The fields are the project setup script that runs when T3 creates a worktree (T3's `ProjectSetupScriptRunner`), the worktree location, and the worktree branch naming. Read and write them through the engine's settings RPCs in `@t3tools/contracts`, so T3 runs the script. Edit the script in a multi-line field with a monospace font.
- [ ] In `CleanupPage.tsx`, drive T3's storage cleanup. Show the automatic cleanup policies (inactive days, after settle, after merge, unchanged, delete with deleted threads, and which local files to keep), with a per-project override. Add **Delete now**, the latest results with each removed or kept worktree and its reason, and T3's manual delete for a single worktree. Follow `docs/user/project-settings.md:229-262`.
- [ ] In `settingsModel.ts`, turn the engine's settings into page values and back, keeping inherited and overridden values apart.

**You see.**

- [ ] The sidebar's settings icon opens an Orca-style settings screen where the operator edits the worktree setup script, the location, and the branch naming, and cleans up worktrees now or by policy.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `settingsModel.test.ts` maps a fixed settings payload with one project override into literal page values, marks which ones are inherited, and turns an edited setup script back into the literal RPC input. Run `vp test run src/settings/settingsModel.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no settings screen, so record that fact. Open the screen at head. Save `w1-settings.png`. Pass when the category list and the Worktrees page render in the Orca layout.
- [ ] Lane 2. Save a setup script for a lane project, then create a worktree for it through the engine. Save `w1-setup-script.txt`. Pass when the script's output appears in the new worktree.
- [ ] Lane 3. Set a project override for the script, then clear it. Save `w1-override.png`. Pass when the page shows overridden, then inherited.
- [ ] Lane 4. Change the worktree location to a scratch folder and create a worktree. Save `w1-location.txt`. Pass when the worktree lands in that folder.
- [ ] Lane 5. Change the branch naming prefix and create a worktree. Save `w1-branch.txt`. Pass when the new branch uses that prefix.
- [ ] Lane 6. Leave a settled lane thread with a worktree, set settled retention to 0, and click **Delete now**. Save `w1-delete-now.png`. Pass when the results list that worktree as removed and its folder is gone.
- [ ] Lane 7. Repeat lane 6 with uncommitted changes in the worktree. Save `w1-kept.png`. Pass when the results list it as kept with the local-changes reason.
- [ ] Lane 8. Delete one worktree by hand from the page. Save `w1-manual.png`. Pass when T3's confirm appears and the worktree is removed after it.
- [ ] Lane 9. Run the Windows app and open the screen. Save `w1-windows.png` from a full-window capture. Pass when the layout fits the window with the usage bar still at the bottom.
- [ ] Lane 10. Run the boundary check and the standards check at head. Save `w1-checks.txt`. Pass when both exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from clicking the settings icon to the Worktrees page's first paint. Trunk has no screen, so the budget is absolute.
- [ ] Probe. Log `board:settings-click` and `board:settings-painted` ten times.
- [ ] Baseline. Record that trunk has no screen, then record the head times.
- [ ] Rule. The median stays under 300 ms, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 1, 6, and 9 screenshots into `apps/board/docs/media/w1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/w1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W1 to the base-branch stack and the operator lands it bottom-up.

## Show the engine version and update the engine from the app (B4)

**Depends on.** W1.

**Files.**

- [ ] Create `apps/board/src/state/engineUpdate.ts` and `apps/board/src/state/engineUpdate.test.ts`.
- [ ] Create `apps/board/src/sidebar/EngineVersion.tsx`.

**Build.**

- [ ] In `engineUpdate.ts`, read the engine version and the `serverSelfUpdate` capability from the server config, and the newest release from `server.getNpmRelease`. Follow `packages/client-runtime/src/connection/outdatedHostUpdate.ts`.
- [ ] Update T3's service through T3's own path. Start `server.updateServerWithProgress`, keep its `updateId`, and match it to the `ready` lifecycle event after the reconnect to report committed or rolled back. For an engine the app reached through `AGENT_BOARD_ENGINE_URL`, show the version only.
- [ ] In `EngineVersion.tsx`, show `Engine <version>` and, when a newer release exists and the app can update that engine, an `Update to <version>` button with progress.

**You see.**

- [ ] The sidebar footer shows the engine version, and an update button appears only when the engine can update itself.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `engineUpdate.test.ts` asserts the outcome for a matching `updateId` with `committed`, a matching `updateId` with a rollback, and a missing `updateId`, against literal expected states. Run `vp test run src/state/engineUpdate.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk does not have the app, so record that fact. Open the head app against a lane engine. Save `b4-regression.png`. Pass when the footer shows the lane engine's version.
- [ ] Lane 2. Reach a lane engine through `AGENT_BOARD_ENGINE_URL`. Save `b4-url-engine.png`. Pass when the version shows and no update button shows.
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
- [ ] In `BoardList.tsx`, nest boards under their project with U1's rows. Archived boards collapse into a pill row, `N archived boards`, like Orca's hidden worktrees row, and opening it shows them with a restore action.
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
- [ ] In the sidebar, expand a board's row into its agent tree with U1's rows, one indent step per nesting level, and a count chip on each parent with its child count and a status dot count, as in Orca's sidebar.
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

## Switch the orchestrator's model and run slash commands from its chat (C1)

**Depends on.** B7.

**Files.**

- [ ] Create `apps/board/src/chat/Composer.tsx`, `apps/board/src/chat/ModelPicker.tsx`, and `apps/board/src/chat/SlashMenu.tsx`.
- [ ] Create `apps/board/src/chat/slash.ts` and `apps/board/src/chat/slash.test.ts`.
- [ ] Edit `apps/board/src/chat/OrchestratorPanel.tsx`, `apps/board/src/providers/providers.ts`, and `apps/board/src/board/CreateBoard.tsx`.

**Build.**

- [ ] Default every new board's orchestrator to Claude Code with `claude-opus-5-5` at `medium` effort. When the engine has no signed-in Claude instance or doesn't offer that model, preselect the first signed-in instance and its default model, and say why under the picker.
- [ ] In `ModelPicker.tsx`, let the operator change the orchestrator's provider instance, model, and effort from the composer, the way T3's chat composer does. The next turn goes out with that `modelSelection` through `startThreadTurn`. Read T3 web's composer model picker under `apps/web/src` for behavior and copy the pattern, never the import.
- [ ] In `SlashMenu.tsx`, open a filtered menu when the operator types `/` at the start of the message. It lists the orchestrator instance's `slashCommands` and `skills` from the engine's server config (`packages/contracts/src/server.ts:111-143`), so Claude Code's commands, installed skills, and plugin skills all appear, plus the composer actions T3's own chat offers. Arrow keys move, Enter picks, Escape closes, and a command with an `input` hint keeps the cursor for its argument. Mirror how T3 web's composer turns a picked command or skill into the message it sends.
- [ ] In `slash.ts`, keep the matching and ranking pure. Prefix matches come first, then word matches, grouped as commands, skills, and T3 actions.

**You see.**

- [ ] A new board's orchestrator starts on Claude Opus 5.5 at medium effort, the composer can switch the model for the next turn, and typing `/` lists Claude Code's commands, skills, and T3's actions.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `slash.test.ts` ranks a fixed list of commands and skills for the inputs `/`, `/re`, and `/rev` into literal expected orders, and turns a picked command with an argument into the literal message text. Run `vp test run src/chat/slash.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. On trunk the board dialog preselects whatever the engine lists first. Create a board at head. Save `c1-default.png`. Pass when the orchestrator thread runs `claude-opus-5-5` at `medium`, read from the thread.
- [ ] Lane 2. Hide the Claude instance from the lane engine and create a board. Save `c1-fallback.png`. Pass when the first signed-in instance is preselected and the reason shows.
- [ ] Lane 3. Switch the model to `claude-sonnet-5-5` in the composer and send a message. Save `c1-switch.png`. Pass when that turn's run reports `claude-sonnet-5-5`.
- [ ] Lane 4. Switch to a Codex instance and send a message. Save `c1-switch-codex.png`. Pass when the turn runs on Codex, or the panel shows T3's reason when it refuses a provider change mid-thread.
- [ ] Lane 5. Type `/`. Save `c1-slash.png`. Pass when the menu lists the instance's slash commands and skills, including `omp-kit` plugin skills, grouped as in `slash.ts`.
- [ ] Lane 6. Type `/comp` and press Enter. Save `c1-compact.png`. Pass when Claude Code runs its compact command in the orchestrator thread.
- [ ] Lane 7. Pick a skill from the menu and send. Save `c1-skill.png`. Pass when the orchestrator's reply shows it loaded that skill.
- [ ] Lane 8. Use only the keyboard to open, move through, pick from, and close the menu. Save `c1-keyboard.png`. Pass when every step works without the mouse and focus returns to the composer.
- [ ] Lane 9. Run the Windows app and open the menu. Save `c1-windows.png` from a full-window capture. Pass when the menu and the model picker fit inside the panel above the usage bar.
- [ ] Lane 10. Run the boundary check and the standards check at head. Save `c1-checks.txt`. Pass when both exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from typing `/` to the menu's first paint with 200 commands and skills. Trunk has no menu, so the budget is absolute.
- [ ] Probe. Log `board:slash-open` and `board:slash-painted` ten times.
- [ ] Baseline. Record that trunk has no menu, then record the head times.
- [ ] Rule. The median stays under 50 ms, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 1, 3, and 5 screenshots into `apps/board/docs/media/c1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/c1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends C1 to the base-branch stack and the operator lands it bottom-up.

## Route everything that needs the user into For-you cards (B8)

**Depends on.** C1.

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
- [ ] On a merged ticket's frame, offer **Remove worktree**, which runs T3's manual worktree delete with its confirm.
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

## Keep the engine and providers up to date from Settings (W2)

**Depends on.** B11.

**Files.**

- [ ] Create `apps/board/src/settings/UpdatesPage.tsx`.
- [ ] Create `apps/board/src/state/updates.ts` and `apps/board/src/state/updates.test.ts`.
- [ ] Edit `apps/board/src/settings/SettingsNav.tsx`, `apps/board/src/settings/settingsModel.ts`, `apps/board/src/sidebar/EngineVersion.tsx`, and `apps/board/src/sidebar/Sidebar.tsx`.

**Build.**

- [ ] Add an Updates page to W1's settings screen. Keep W1's Orca layout and its `SettingsSection` and `SettingsRow` rows, so the board keeps one settings look. Take the page's content, states, and wording from T3 web's own provider update UI, read only, in `apps/web/src/components/settings/ProviderInstanceCard.tsx`, `apps/web/src/components/ProviderUpdatesAction.tsx`, `apps/web/src/components/sidebar/updateEverything.logic.ts`, and `apps/web/src/components/ProviderUpdateLaunchNotification.logic.ts`.
- [ ] In the Engine section, show the installed engine version and the latest npm release, an **Update now** button that runs B4's existing update flow in `apps/board/src/state/engineUpdateAtoms.ts`, and an **Update the engine automatically** switch that starts off.
- [ ] In the Providers section, show one row per provider instance with its current and latest version and status from `providers[].versionAdvisory`, and its progress from `providers[].updateState`. **Update** calls `server.updateProvider` when `canUpdate` is true, and otherwise the row shows `updateCommand` with a copy button.
- [ ] Add a **Check for provider updates** switch bound to T3's `enableProviderUpdateChecks` through `server.updateSettings`, and an **Update providers automatically** switch that starts off. Keep the board's own switches where W1 keeps board settings.
- [ ] Add **Update everything**, which runs each offered update in turn, as T3's sidebar action does.
- [ ] In `state/updates.ts`, decide each item's action as a pure function of the offer, the switch, and the active runs. An automatic update starts only when no thread on that engine, or on that provider instance, has an active run. Otherwise it waits and starts when those runs go idle. It never interrupts a run, and each automatic update shows a toast and a last-updated line on the page.
- [ ] When an update is offered and its switch is off, show a dot on the sidebar's settings icon and one toast per new version, as T3's launch notification does. The toast opens the Updates page.
- [ ] In `Sidebar.tsx`, move the engine status and version to the very bottom of the left sidebar, below the settings and help icons.

**You see.**

- [ ] Settings has an Updates page in the board's Orca layout that lists the engine, Claude Code, and Codex with their versions, updates each one on a click or automatically between runs, and the sidebar flags an offered update. The engine status sits at the bottom of the sidebar, below the settings and help icons.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `updates.test.ts` maps fixed inputs of offer, switch, and active runs to literal expected actions, covering offered with the switch off, automatic with no runs, automatic with an active run, a finished run releasing a waiting update, and an instance whose `canUpdate` is false. Run `vp test run src/state/updates.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. Every provider lane runs its engine with `HOME` and `NPM_CONFIG_PREFIX` under `/tmp/<lane>/`, so an update never touches the operator's own Claude Code, Codex, or `~/.t3`.

- [ ] Lane 1. Regression lane against trunk. Trunk has no Updates page, so record that fact. Open it at head. Save `w2-updates.png`. Pass when the engine, Claude Code, and Codex rows show their current versions.
- [ ] Lane 2. Point the lane's Claude instance at an older Claude Code installed under the lane's scratch prefix. Save `w2-behind.png`. Pass when its row shows it behind with the latest version.
- [ ] Lane 3. Click **Update** on that row. Save `w2-provider-update.png`. Pass when the row moves through running to succeeded and then shows the new version.
- [ ] Lane 4. Turn **Check for provider updates** off. Save `w2-checks-off.txt`. Pass when T3's `enableProviderUpdateChecks` reads false from the server config.
- [ ] Lane 5. Turn **Update providers automatically** on while a turn runs on that instance. Save `w2-auto-wait.png`. Pass when the update waits for the turn to end, then runs, and a toast reports it.
- [ ] Lane 6. In the scratch WSL distro from the boot recipe, install the T3 service one release behind npm's latest and turn **Update the engine automatically** on. Save `w2-engine-auto.png`. Pass when the footer shows the latest version with no click, then unregister the distro.
- [ ] Lane 7. With both switches off and an update offered, launch twice. Save `w2-notify.png`. Pass when the settings icon shows the dot and only the first launch shows the toast.
- [ ] Lane 8. With two updates offered, click **Update everything**. Save `w2-everything.png`. Pass when both finish in turn.
- [ ] Lane 9. Run the Windows app and open the Updates page. Save `w2-windows.png` from a full-window capture. Pass when it matches the other settings pages' layout and the sidebar shows the settings and help icons above the engine status.
- [ ] Lane 10. Run the boundary check and the standards check at head. Save `w2-checks.txt`. Pass when both exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from clicking Updates in the settings list to the page's first paint.
- [ ] Probe. Log `board:updates-open` and `board:updates-painted` ten times.
- [ ] Baseline. Record the Worktrees page's open time at head as the comparison.
- [ ] Rule. The median stays under 100 ms, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 1, 3, and 7 screenshots into `apps/board/docs/media/w2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/w2-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends W2 to the base-branch stack and the operator lands it bottom-up.

## Keep the orchestrator's rules after compaction (R1)

**Depends on.** W2.

**Files.**

- [ ] Create `apps/board/src/orchestrator/orchestratorInstance.ts` and `apps/board/src/orchestrator/orchestratorInstance.test.ts`.
- [ ] Create `apps/board/docs/skill-feed-probe.md`.
- [ ] Edit `apps/board/src/orchestrator/brief.md`, `apps/board/src/orchestrator/brief.ts`, `apps/board/src/orchestrator/launch.ts`, `apps/board/src/state/orchestrator.ts`, `apps/board/src/state/boardModel.ts`, and `apps/board/src/board/AgentCard.tsx`.

**Build.**

- [ ] Record the skill feed probe's measured results in `docs/skill-feed-probe.md`, from `/tmp/skill-probe/evidence/`. An appended system prompt file survived `/compact` 10 of 10 times. A rule only in the first message survived short chats but was lost from the summary in 2 of 2 long orchestrator sessions. A `$skill` survived 4 of 4 short chats. `--disallowedTools` removed Claude Code's built-in subagent tool, and a built-in subagent call otherwise becomes a T3 child thread the board shows as an unassigned card.
- [ ] Split `brief.md` into standing rules and board facts. The standing rules hold the store contract, the role registry, how to reach the user, the builder-cap rule, and how to work. The board facts hold the board folder, the builder cap's number, and the project. The standing rules tell the orchestrator that after a compaction it finds its board folder by matching its own thread ID to `orchestratorThreadId` in `.agentboard/*/board.json` under its working folder.
- [ ] In `orchestratorInstance.ts`, create or reuse one orchestrator Claude instance per engine through T3's own instance settings. Give it the standing rules as an appended system prompt, through `--append-system-prompt` or `--append-system-prompt-file` in its launch arguments, and `--disallowedTools "Task,Agent"`. Use the form that the live lanes show reaches the session. Children keep running on their roles' targets, so they never get the orchestrator's rules.
- [ ] Start every new orchestrator on that instance, keep C1's model and effort choice within it, and move an existing board's orchestrator to it on its next turn.
- [ ] For a Codex orchestrator, find whether T3 can give Codex standing instructions that survive compaction. If it can't, keep the brief in the first message and say so in the new-board dialog.
- [ ] Fix the standing rules the end-to-end run broke, per `apps/board/docs/e2e-run-2026-11-20.md`. Open each PR against the base the user named, or ask the user before stacking. Say when a ticket moves to `verifying` and to `pr`. Take every time from `date -u +%Y-%m-%dT%H:%M:%SZ`. Tell every agent that changes or checks files to leave its evidence in `<its worktree>/.omp/artifacts/<ticket key>/` with a `README.txt` that lists each file and what it proves, which B9 reads. Require evidence on every merge condition, as an absolute path or a link. Also find why the run's reviewers fell back to the orchestrator's model because the instance did not offer `claude-fable-5-1`, when B6 measured it offered, and fix it if the cause is in the board.
- [ ] In `boardModel.ts` and `AgentCard.tsx`, flag a child thread that T3 created from a provider subagent call, not from `delegate_task`, with an "Outside the role registry" badge.

**You see.**

- [ ] An orchestrator still follows its rules and knows its board after a compaction, can't start Claude's built-in subagents, and any agent started outside the registry shows a badge.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `orchestratorInstance.test.ts` builds the instance settings from fixed standing rules and checks the literal launch arguments, reuses an existing orchestrator instance instead of adding a second one, and leaves every other instance unchanged. Run `vp test run src/orchestrator/orchestratorInstance.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a long orchestrator session with a goal and a scout on trunk and at head, then `/compact` and ask for the builder cap and where tickets go. Save `r1-compact.png`. Pass when head answers from its rules with no read of old session files, and record trunk's answer.
- [ ] Lane 2. After `/compact` at head, ask for the board folder. Save `r1-board-folder.txt`. Pass when it names the right folder.
- [ ] Lane 3. Create two boards, then ask a child for a phrase that only the standing rules hold. Save `r1-instance.txt`. Pass when both orchestrators run on one orchestrator instance, the engine gained exactly one instance, and the child doesn't know the phrase.
- [ ] Lane 4. Rerun the end-to-end goal from `apps/board/docs/e2e-run-2026-11-20.md` verbatim, with CI on a local runner. Save `r1-e2e.md`. Pass when the PR bases follow the goal's words or the orchestrator asks first, each ticket passes through `verifying` and `pr`, every ticket frame shows a nonzero artifact count, every merge condition has evidence, decision times match the real clock within 2 minutes, and reviewers run on `claude-fable-5-1` when the instance offers it.
- [ ] Lane 5. Ask the orchestrator to use Claude's built-in subagent tool. Save `r1-builtin.txt`. Pass when no extra child thread appears.
- [ ] Lane 6. Open a board created on trunk and send a message. Save `r1-migrate.txt`. Pass when that turn runs on the orchestrator instance.
- [ ] Lane 7. Switch the model in C1's picker. Save `r1-switch.txt`. Pass when the turn stays on the orchestrator instance with the new model.
- [ ] Lane 8. On a trunk-style instance, force a built-in subagent call. Save `r1-badge.png`. Pass when its card shows the badge.
- [ ] Lane 9. Create a Codex orchestrator and run the lane 1 check. Save `r1-codex.txt`. Pass when the result and the dialog's note match.
- [ ] Lane 10. Run the boundary check and the standards check at head. Save `r1-checks.txt`. Pass when both exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from sending a message to the orchestrator's first streamed token.
- [ ] Probe. Send the same short message ten times on trunk and ten at head.
- [ ] Baseline. Record trunk's times.
- [ ] Rule. The head median stays within 500 ms of trunk's, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 1, 5, and 8 screenshots or captures into `apps/board/docs/media/r1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/r1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends R1 to the base-branch stack and the operator lands it bottom-up.

## Make the Linear approval rule cover MCP write tools (K2)

**Depends on.** R1.

**Files.**

- [ ] Edit `apps/board/plugins/omp-kit/engine/rules.mjs`, `apps/board/plugins/omp-kit/engine/hook.mjs`, and `apps/board/plugins/omp-kit/engine/rules.test.mjs`.
- [ ] Edit the operator's `~/.omp/agent/rules/linear-writes-require-approval.md` only after the operator approves the exact diff.

**Build.**

- [ ] Start from the measured gap in `apps/board/docs/issue-tools-probe.md`. The rule's scope, `tool:write, tool:bash`, never covers an MCP tool, so in Claude Code neither `mcp__linear__save_issue` nor T3's `mcp__t3-code__create_issue`, `comment_on_issue`, and `set_issue_state` trigger it.
- [ ] Find the scope syntax omp's own rule engine accepts for MCP tool names, from omp's rule docs, and use only that, so one rule file still drives both omp and Claude Code.
- [ ] Let `omp-kit` answer a matching tool call with Claude Code's `ask` decision, not `deny`, when the rule asks for approval, so the operator approves in place. Use a rule field omp itself accepts or ignores, and say which.
- [ ] Show the operator the rule file's diff in chat, and edit the file only after the operator approves it.

**You see.**

- [ ] In Claude Code, a Linear or T3 issue write waits for the operator's approval with the rule's text, a read runs freely, and every other tool behaves as before.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `rules.test.mjs` feeds a fixed rule with the new scope and payloads for `mcp__linear__save_issue`, `mcp__t3-code__set_issue_state`, `mcp__t3-code__read_issue`, a `Bash` call that mentions Linear, and a `Write` call, and checks each literal decision. Run `node --test apps/board/plugins/omp-kit/engine/rules.test.mjs`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Replay the hook on an `mcp__linear__save_issue` payload at trunk and at head. Save `k2-replay.txt`. Pass when trunk prints nothing and head asks.
- [ ] Lane 2. In a T3 Claude thread with the plugin loaded, call `set_issue_state`. Save `k2-t3-ask.txt`. Pass when the call waits as an engine approval with the rule's text.
- [ ] Lane 3. Call `read_issue`. Save `k2-read.txt`. Pass when it runs with no prompt.
- [ ] Lane 4. Decline the approval from lane 2. Save `k2-decline.txt`. Pass when the call never reaches T3's handler.
- [ ] Lane 5. Approve it. Save `k2-approve.txt`. Pass when the call reaches the handler.
- [ ] Lane 6. Replay a `Bash` call that mentions Linear. Save `k2-bash.txt`. Pass when the decision matches trunk's.
- [ ] Lane 7. Replay every other rule's fixtures at trunk and at head. Save `k2-others.txt`. Pass when every decision is identical.
- [ ] Lane 8. Start an omp session with the edited rule file. Save `k2-omp.txt`. Pass when omp loads the rule with no error and applies it to an MCP Linear write.
- [ ] Lane 9. Run a plain Claude Code session outside T3 with the plugin loaded and call `mcp__linear__save_issue` against a scratch Linear workspace or a stub server. Save `k2-cli.txt`. Pass when Claude Code asks before the call.
- [ ] Lane 10. Run the boundary check and the standards check at head. Save `k2-checks.txt`. Pass when both exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Hook time per tool call.
- [ ] Probe. Replay 200 mixed payloads at trunk and at head.
- [ ] Baseline. Record trunk's times.
- [ ] Rule. The head median stays under 50 ms, recorded for O1.

**Review gate.** None. K2 changes no screen.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends K2 to the base-branch stack and the operator lands it bottom-up.

## Format the orchestrator chat the way T3 does (C2)

**Depends on.** K2.

**Files.**

- [ ] Create `apps/board/src/chat/CodeBlock.tsx`, `apps/board/src/chat/WorkLog.tsx`, and `apps/board/src/chat/MessageActions.tsx`.
- [ ] Create `apps/board/src/chat/markdownBlocks.ts` and `apps/board/src/chat/markdownBlocks.test.ts`.
- [ ] Edit `apps/board/src/chat/Markdown.tsx`, `apps/board/src/chat/AssistantRow.tsx`, `apps/board/src/chat/UserRow.tsx`, `apps/board/src/chat/WorkRow.tsx`, `apps/board/src/chat/timeline.ts`, `apps/board/package.json`, and `standards/.dependency-cruiser.cjs`.

**Build.**

- [ ] Let the board import `@t3tools/shared/<subpath>`. Add `shared` to the allowed packages in the `board-reaches-t3-through-contracts` rule and add the package to `apps/board/package.json`.
- [ ] Copy each piece's behavior from T3 web, read only, and never import from `apps/web`. The sources are `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/components/chat/MarkdownCodeBlock.tsx`, `apps/web/src/components/chat/markdownStreamBlocks.ts`, `apps/web/src/components/chat/WorkLog.tsx`, `apps/web/src/components/chat/MessageCopyButton.tsx`, and the components they use.
- [ ] In `CodeBlock.tsx`, color fenced code with the same Shiki highlighter and theme T3 web uses, with a copy button and the language label.
- [ ] In `markdownBlocks.ts`, split a reply into markdown blocks so a streaming reply re-renders only its last block, as T3's stream blocks do.
- [ ] In `WorkLog.tsx`, show each tool call with its icon and label, a command's output, the files it changed, and a failed call's error, as T3's work log does.
- [ ] In `Markdown.tsx`, render `$skill` mentions as chips, file links that open B9's viewer for artifacts, PR and issue links that open B11's panel, Mermaid blocks, math, GitHub alerts, `<details>` blocks, and tables, as T3's chat markdown does.
- [ ] In `MessageActions.tsx`, give each message a copy button and a timestamp, and show the running turn's elapsed time.

**You see.**

- [ ] The orchestrator chat reads like T3's chat, with colored code and copy, a full work log, skill chips, working links, diagrams, and per-message copy and time.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `markdownBlocks.test.ts` splits a fixed streamed reply with a paragraph, a fenced block cut mid-stream, and a list into literal expected blocks, and keeps every finished block unchanged as text appends. Run `vp test run src/chat/markdownBlocks.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. On trunk a fenced TypeScript block renders plain. Ask the orchestrator for one at head. Save `c2-code.png`. Pass when its tokens are colored and copy puts the exact code on the clipboard.
- [ ] Lane 2. Open one thread in the lane engine's own T3 web app and in the board. Save `c2-side-by-side.png`. Pass when code, lists, tables, links, and tool rows match T3's layout in the board's tokens.
- [ ] Lane 3. Run a turn that runs a shell command and edits a file. Save `c2-worklog.png`. Pass when the command, its output, and the changed file show in the work log.
- [ ] Lane 4. Stream a reply of about 4,000 words. Save `c2-stream.png`. Pass when finished blocks never re-render while the last one grows, read from React profiler marks.
- [ ] Lane 5. Send a message that names a skill. Save `c2-skill.png`. Pass when the mention renders as a chip.
- [ ] Lane 6. Get a reply that links an artifact path. Save `c2-filelink.png`. Pass when the link opens B9's viewer on that file.
- [ ] Lane 7. Get a reply with a Mermaid block, an equation, and a GitHub alert. Save `c2-extras.png`. Pass when all three render.
- [ ] Lane 8. Copy a message and read its timestamp. Save `c2-copy.txt`. Pass when the clipboard holds the message's markdown and the time matches the thread's record.
- [ ] Lane 9. Run the Windows app on a long thread. Save `c2-windows.png` from a full-window capture. Pass when code blocks and the work log fit the panel.
- [ ] Lane 10. Run the boundary check, the standards check, and the dependency rules at head. Save `c2-checks.txt`. Pass when all three exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. The gap from `board:token-received` to `board:token-painted` while a reply of about 4,000 words streams.
- [ ] Probe. Log both marks for every update of that reply.
- [ ] Baseline. Record trunk's gaps on the same reply.
- [ ] Rule. The p95 stays under 50 ms, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 1, 2, and 3 screenshots into `apps/board/docs/media/c2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/c2-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends C2 to the base-branch stack and the operator lands it bottom-up.

## Browse files from a right sidebar explorer and read them in the main view, as Orca does (F1)

**Depends on.** C2.

**Files.**

- [ ] Create `apps/board/src/files/FileExplorer.tsx`, `apps/board/src/files/FileTree.tsx`, `apps/board/src/files/FileView.tsx`, `apps/board/src/files/FilePreview.tsx`, and `apps/board/src/files/OpenInEditor.tsx`.
- [ ] Create `apps/board/src/files/editorChoice.ts` and `apps/board/src/files/editorChoice.test.ts`.
- [ ] Edit `apps/board/src/artifacts/ArtifactViewer.tsx`, `apps/board/src/domain/artifact.ts`, the right panel host B11 created, and the main view host in `App.tsx`.

**Build.**

- [ ] Copy Orca's file layout, and capture Orca's explorer, an opened file, its three-dot menu, and its right sidebar icons first as the references. The right sidebar is Orca's icon-only tab strip with Orca's icons, underline, tooltips, and header row. Its explorer tab, with Orca's files icon, holds the file tree, and D1 and M1 add Source Control and Checks after it. Clicking a file opens it as a tab in the main view beside the board, the way Orca opens it, and closing it returns to the canvas. A file link in the chat and an artifact card open files the same way. Move B11's browser out of the right panel into a main-view tab with a globe icon, as Orca shows its browser, so every `openInPanel` caller opens a browser tab there. The explorer's root picker lists the project and every ticket worktree on the board. Leave out anything Orca's file flow does not have, and leave out Orca's Agents tab.
- [ ] Copy behavior from T3 web's file browser, read only, and never import from `apps/web`. The sources are `apps/web/src/components/files/FileBrowserPanel.tsx`, `FileExplorerPane.tsx`, `FilePreviewPanel.tsx`, `fileTreeExpansion.ts`, and `useDirectoryEntries`. Use the same tree and code packages T3 web uses.
- [ ] In `FileTree.tsx`, list folders lazily through `projects.listEntries` with paths relative to the chosen root's `cwd`, and keep expansion per root.
- [ ] In `FilePreview.tsx`, show code with C2's colors, markdown rendered, images through signed media URLs, TSV and CSV as tables through `@t3tools/shared/delimitedPreview`, PDFs as pages, and a placeholder for other binaries, each with copy and download.
- [ ] The board never edits a file. In `OpenInEditor.tsx`, a three-dot button in the preview's header opens a menu shaped like Orca's three-dot menu, with one **Open in <editor>** item per editor in the server config's `availableEditors`. Capture Orca's own three-dot menu first as the reference. Each item opens the file through T3's `shell.openInEditor`, with the file's absolute path as `cwd`, an empty `position`, and the root as `projectRoot`. Hide the button when the list is empty.
- [ ] In `editorChoice.ts`, remember the operator's last picked editor in local settings and list it first in the menu. When that editor is no longer available, keep the server's order.
- [ ] When T3 refuses the launch, show T3's reason in the preview's header.

**You see.**

- [ ] The right sidebar's explorer shows the project's and each worktree's file tree, a clicked file opens in the main view as it does in Orca, and the three-dot menu opens the file in VS Code, Cursor, or Zed, with the last pick listed first.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `editorChoice.test.ts` maps a fixed `availableEditors` list and a stored pick to the menu's order, including a stored pick that is no longer available and an empty list, each with a literal expected result. Run `vp test run src/files/editorChoice.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no explorer, so record that fact. Open the explorer tab at head on a seeded project. Save `f1-tree.png` beside the Orca reference. Pass when the right sidebar shows the tree and the tree matches `git ls-files` for the folders opened.
- [ ] Lane 2. Switch the root to a ticket worktree. Save `f1-worktree.png`. Pass when the tree shows that worktree's files, including its `.omp/artifacts/`.
- [ ] Lane 3. Open a TypeScript file, a markdown file, an image, a TSV, and a PDF. Save `f1-previews.png`. Pass when each renders as the Build boxes say.
- [ ] Lane 4. Open a file from the explorer, a chat file link, and an artifact card. Save `f1-open-from.png` beside the Orca reference. Pass when each opens in the main view as Orca opens it, and closing it returns the canvas.
- [ ] Lane 5. Read `availableEditors` from the lane engine's server config, and open the three-dot menu. Save `f1-editors.txt` and `f1-menu.png` beside the Orca reference capture. Pass when the menu lists exactly those editors and matches Orca's menu shape.
- [ ] Lane 6. Choose **Open in VS Code** on a project file. Save `f1-open-vscode.png` from a full-screen capture. Pass when VS Code shows that file.
- [ ] Lane 7. Choose **Open in Cursor**, reload the app, and open the menu again. Save `f1-open-cursor.png`. Pass when Cursor showed the file and the menu lists Cursor first after the reload.
- [ ] Lane 8. Copy and download a file. Save `f1-copy.txt`. Pass when the clipboard and the downloaded file match the file's contents.
- [ ] Lane 9. Run the Windows app with the explorer, an opened file, a browser tab opened from a PR chip, and the orchestrator chat. Save `f1-windows.png` from a full-window capture. Pass when the sidebar, the main-view tabs, and the three-dot menu fit and match the Orca references, and the PR page loads in its main-view tab.
- [ ] Lane 10. Run the boundary check, the standards check, and the dependency rules at head. Save `f1-checks.txt`. Pass when all three exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from expanding a folder of 2,000 entries to its rows' first paint, and from selecting a 1 MB text file to its preview's first paint.
- [ ] Probe. Log `board:tree-expand`, `board:tree-painted`, `board:preview-open`, and `board:preview-painted` ten times each.
- [ ] Baseline. Trunk has no file view. Record the head times.
- [ ] Rule. Both medians stay under 100 ms, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 1, 3, and 5 screenshots into `apps/board/docs/media/f1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/f1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends F1 to the base-branch stack and the operator lands it bottom-up.

## Review a branch's changes in a Changes panel (D1)

**Depends on.** F1.

**Files.**

- [ ] Create `apps/board/src/changes/ChangesPanel.tsx`, `apps/board/src/changes/DiffView.tsx`, `apps/board/src/changes/CommitList.tsx`, and `apps/board/src/changes/CommitBox.tsx`.
- [ ] Create `apps/board/src/changes/changeSet.ts` and `apps/board/src/changes/changeSet.test.ts`.
- [ ] Edit the right panel host, `apps/board/src/board/TicketFrame.tsx`, `apps/board/src/board/AgentCard.tsx`, and `apps/board/src/board/PrChip.tsx`.

**Build.**

- [ ] Add a Source Control tab to the right sidebar after the explorer, with Orca's git-branch icon and tooltip, laid out like Orca's source control view in `/home/kyle/personalDev/main/artifacts/agent-board-prototype/refs/orca-right-source-control.png`. It shows the PR number with search and more, the branch and its base with an open-on-host link, a commit message box, a Commit button with a dropdown, the changed files, and a collapsible Commits section. It works on the same roots as F1's explorer, the project and each ticket worktree.
- [ ] Copy behavior from T3 web's diff panel, read only, and never import from `apps/web`. The sources are `apps/web/src/components/DiffPanel.tsx`, `DiffPanelShell.tsx`, `DiffWorkerPoolProvider.tsx`, `DiffFilePathCopyButton.tsx`, and `apps/web/src/components/diffs/`. Use the same diff package T3 web uses.
- [ ] Offer two sources, as T3 does. **Uncommitted** reads `review.getDiffPreview` with `sourceKind: "working-tree"`. **Branch** reads it with `sourceKind: "branch-range"` against the ticket's base from `tickets.json`, or the default branch for the project.
- [ ] In `CommitList.tsx`, list the branch's commits from `review.getBranchCommits`, and show one commit's diff with `commitSha`.
- [ ] In `CommitBox.tsx`, commit through T3's `git.runStackedAction` with `commit`, `commit_push`, or `commit_push_pr` from the dropdown, using the typed message, or T3's own message when the box is empty. Copy the flow from T3 web's `apps/web/src/components/GitActionsControl.tsx`, read only. After a commit in a ticket worktree, offer **Tell the orchestrator**, as F1 does after a save.
- [ ] In `DiffView.tsx`, show a changed-file tree with added and removed counts, unified and split views, an ignore-whitespace switch, and the full file through `review.getDiffFileContents` on expand.
- [ ] In `changeSet.ts`, turn a diff preview into the file tree and totals as a pure function.
- [ ] Open a ticket's branch diff from its frame, its agent cards, and its PR chip. Clicking a file opens it in F1's file view at that line.

**You see.**

- [ ] A Changes tab shows a project's or a ticket worktree's uncommitted changes, its branch diff against the base, and each commit, in unified or split view, and opens straight from a ticket.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `changeSet.test.ts` turns a fixed diff preview with an added, a modified, a renamed, and a deleted file into a literal expected tree with per-file and total counts. Run `vp test run src/changes/changeSet.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no Changes panel, so record that fact. Make uncommitted edits in a seeded project and open **Uncommitted** at head. Save `d1-uncommitted.png`. Pass when the files and counts match `git diff --stat`.
- [ ] Lane 2. Open **Branch** on a ticket worktree with three commits over its base. Save `d1-branch.png`. Pass when the files and counts match `git diff --stat <base>...HEAD`.
- [ ] Lane 3. Pick one commit. Save `d1-commit.png`. Pass when the diff matches `git show --stat <sha>`.
- [ ] Lane 4. Switch between unified and split, and turn on ignore whitespace on a whitespace-only change. Save `d1-views.png`. Pass when both views render and the whitespace change hides.
- [ ] Lane 5. Expand a file to its full contents, then diff a renamed and a deleted file. Save `d1-full.png`. Pass when the unchanged lines show around the hunks and both files show with their change type.
- [ ] Lane 6. Type a message and pick **Commit and push** in a ticket worktree. Save `d1-commit-box.png`. Pass when `git log` shows the commit with that message and the remote branch has it.
- [ ] Lane 7. Open the diff from a ticket frame, an agent card, and a PR chip. Save `d1-entry.png`. Pass when each opens that ticket's branch diff.
- [ ] Lane 8. Click a changed file. Save `d1-open-file.png`. Pass when F1's file view opens it at the changed line.
- [ ] Lane 9. Run the Windows app with a 50-file diff open. Save `d1-windows.png` from a full-window capture. Pass when the tree and diff fit beside the board and the layout matches Orca's reference.
- [ ] Lane 10. Run the boundary check, the standards check, and the dependency rules at head. Save `d1-checks.txt`. Pass when all three exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from opening a 50-file, 5,000-line branch diff to the first file's hunks painting.
- [ ] Probe. Log `board:diff-open` and `board:diff-painted` ten times.
- [ ] Baseline. Trunk has no panel. Record the head times.
- [ ] Rule. The median stays under 500 ms, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 1, 2, and 4 screenshots into `apps/board/docs/media/d1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/d1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends D1 to the base-branch stack and the operator lands it bottom-up.

## Show the PR, its checks, and its comments in a Checks tab (M1)

**Depends on.** D1.

**Files.**

- [ ] Create `apps/board/src/checks/ChecksPanel.tsx`, `apps/board/src/checks/CheckRow.tsx`, and `apps/board/src/checks/PrComments.tsx`.
- [ ] Create `apps/board/src/checks/checkList.ts` and `apps/board/src/checks/checkList.test.ts`.
- [ ] Edit the right panel host, `apps/board/src/board/PrChecks.tsx`, and `apps/board/src/board/ReadinessChecklist.tsx`.

**Build.**

- [ ] Add a Checks tab after Source Control, with Orca's list-checks icon and its CI status dot, laid out like Orca's in `/home/kyle/personalDev/main/artifacts/agent-board-prototype/refs/orca-right-checks.png`. It has a PR header with the number, a draft badge, the title, the update time, refresh, and a more menu, then the primary PR action with a dropdown, a collapsible checks group headed by its rollup, one row per check, and a comments section with All, Humans, and Bots filters.
- [ ] Copy behavior from T3 web's `apps/web/src/components/pullRequest/PullRequestChecksPopover.tsx`, `pullRequestPresentation.tsx`, and `pullRequestDetail.logic.ts`, read only.
- [ ] Read the header from `pullRequests.detail`. The action button runs `pullRequests.runAction` with `ready`, `draft`, or `update-branch` as the PR's state allows. A merge still goes through the For-you merge approval card.
- [ ] In `CheckRow.tsx`, show the status icon for each of the seven statuses, the name, a **Required** badge from `required`, GitHub's `description` when present, "Running for" a duration from B10's clock on a pending check, and a link that opens `url` in B11's panel. T3's `PullRequestCheck` has no start time, duration, age, or steps, so a row shows those only when `description` carries them, and its expander shows the description and the link.
- [ ] In `PrComments.tsx`, list comments and review threads from `pullRequests.activity` with author, time, a bot badge, the body through C2's markdown, and reactions, filtered by All, Humans, and Bots.
- [ ] Use the same rows in B10's peek drawer and on merge approval cards.
- [ ] In `checkList.ts`, keep sorting and the rollup pure. Failing checks come first, then running, then the rest, and the rollup reads like "1 failing, 2 running, 8 passing".

**You see.**

- [ ] A Checks tab shows the ticket's PR like Orca does, with each check's status, its required flag, its link, and the PR's comments, and the drawer and merge cards use the same rows.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `checkList.test.ts` sorts a fixed list with all seven statuses, a required check, and a placeholder into a literal expected order and rollup text. Run `vp test run src/checks/checkList.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. A lane that needs a real PR uses the shared lane repo from the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk's drawer lists check names only. Open the Checks tab at head on a PR with passing, failing, running, and skipped checks. Save `m1-checks.png`. Pass when the rows match `gh pr checks`.
- [ ] Lane 2. Watch a running check finish. Save `m1-running.png`. Pass when its row moves from running to passed with no reload.
- [ ] Lane 3. Mark one check required by branch protection. Save `m1-required.png`. Pass when only that row shows **Required**.
- [ ] Lane 4. Open a check's link. Save `m1-link.png`. Pass when the run page opens in the panel.
- [ ] Lane 5. Add a human comment and a bot comment. Save `m1-comments.png`. Pass when each filter shows the right count.
- [ ] Lane 6. Use **Mark ready for review** on a draft PR. Save `m1-ready.txt`. Pass when `gh pr view` shows it ready.
- [ ] Lane 7. Record which checks carry a duration in `description`. Save `m1-description.txt`. Pass when every row that has one shows it.
- [ ] Lane 8. Open the drawer and the merge approval card for the same ticket. Save `m1-same-rows.png`. Pass when both show the same rows.
- [ ] Lane 9. Run the Windows app with the Checks tab open. Save `m1-windows.png` from a full-window capture. Pass when the layout matches Orca's reference.
- [ ] Lane 10. Run the boundary check, the standards check, and the dependency rules at head. Save `m1-checks.txt`. Pass when all three exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from opening the Checks tab on a PR with 50 checks and 100 comments to its first paint.
- [ ] Probe. Log `board:checks-open` and `board:checks-painted` ten times.
- [ ] Baseline. Trunk has no tab. Record the head times.
- [ ] Rule. The median stays under 200 ms, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 1, 5, and 9 screenshots into `apps/board/docs/media/m1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/m1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends M1 to the base-branch stack and the operator lands it bottom-up.

## Add Linear and GitHub issues to a board as work (L1)

**Depends on.** M1.

**Files.**

- [ ] Create `apps/board/src/settings/IntegrationsPage.tsx`.
- [ ] Create `apps/board/src/issues/IssuePicker.tsx`, `apps/board/src/issues/AddFromIssue.tsx`, and `apps/board/src/issues/IssueChip.tsx`.
- [ ] Create `apps/board/src/issues/issueLinks.ts` and `apps/board/src/issues/issueLinks.test.ts`.
- [ ] Edit `apps/board/src/board/OrchestratorCard.tsx`, `apps/board/src/board/TicketFrame.tsx`, `apps/board/src/settings/SettingsNav.tsx`, `apps/board/src/domain/ticket.ts`, `apps/board/src/domain/forYou.ts`, `apps/board/src/orchestrator/brief.md`, and `apps/board/src/orchestrator/brief.ts`.

**Build.**

- [ ] Add an Integrations page to the settings screen in W1's Orca layout. Connect Linear with a personal API key through `issueTrackers.connect`, which T3 probes and keeps as an engine secret. Show each tracker from `issueTrackers.list`, disconnect with a null token, and bind each project to a Linear team through `issueTrackers.bindProject`. Copy the flow from T3 web's `apps/web/src/components/settings/IntegrationsSettings.tsx` and `IssueTrackerSettings.tsx`, read only.
- [ ] A board is a goal the orchestrator organizes, so issues come in as work on an existing board, never as the seed of a new one. Add **Add from tracker** to the orchestrator card. It opens a picker with GitHub and Linear tabs and a search box, laid out like the issue picker in Orca's Create worktree dialog. The tabs search through `issues.list`. Copy issue rows and search from T3 web's `apps/web/src/components/issue/`, read only.
- [ ] Picking an issue sends the orchestrator a ticket request that carries the issue's description and comments from `issues.detail` and `issues.comments`.
- [ ] Add an optional `issue` field, holding the tracker and the key, to the ticket schema in `domain/ticket.ts`, and tell the orchestrator in `brief.md` to set it when a ticket maps to an issue, such as a Linear child issue.
- [ ] In `IssueChip.tsx`, show a linked ticket's issue key, state, and assignee from `issues.detail` on its frame, open the issue in B11's panel on click, and list its linked threads from `issues.linkedThreads`.
- [ ] Route every tracker write through the operator. `brief.md` tells the orchestrator to ask for a create, a state change, or a comment as a For-you item of a new `tracker_write` kind that states the exact change. **Approve** makes that change through `issues.create`, `issues.setState`, or `issues.comment` and messages the orchestrator the result, and **Hold** changes nothing.
- [ ] Gate the agents' own tracker tools, per `apps/board/docs/issue-tools-probe.md`. Every agent in a T3 thread has T3's eight issue tools, named `mcp__t3-code__*` in Claude threads and `mcp__t3_code__*` in Codex threads, and T3 runs `create_issue`, `comment_on_issue`, and `set_issue_state` with no approval in every runtime mode. For Claude threads, write a permission rule that asks for those three tools into the project's and each ticket worktree's `.claude/settings.local.json`, so each call waits as an engine approval card in B8's For-you lane. For Codex threads, gate the three `mcp__t3_code__` writes and Codex's own `mcp__codex_apps__linear_*` writes through Codex's approval settings, or turn tracker writes off for Codex orchestrators and say why in the dialog. The operator's `omp-kit` Linear rule never fires on an MCP tool, so it is no fallback. Reads stay free.
- [ ] In `issueLinks.ts`, keep the pure pieces, which find issue keys in text, join tickets to issues, and turn an approved `tracker_write` item into the T3 call's input.

**You see.**

- [ ] Settings connects Linear, **Add from tracker** brings a Linear or GitHub issue onto a board as a ticket, ticket frames show their issue's state, and every write to the tracker waits for the operator's approval.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `issueLinks.test.ts` finds the keys in a fixed text, joins a fixed `tickets.json` to fixed issues, and turns approved create, state, and comment items into literal expected `issues.create`, `issues.setState`, and `issues.comment` inputs. Run `vp test run src/issues/issueLinks.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. Linear lanes read the operator's workspace with a key the operator enters at lane time, and never write to it. Write lanes use a scratch Linear workspace key the operator provides, or the shared lane repo from the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk's orchestrator card has no **Add from tracker**, so record that fact. Connect Linear at head. Save `l1-connect.png`. Pass when `issueTrackers.list` shows Linear connected and the key appears in no board file or log.
- [ ] Lane 2. Bind the project to a team. Save `l1-bind.png`. Pass when `issues.list` returns that team's issues.
- [ ] Lane 3. Search the Linear tab. Save `l1-search.png`. Pass when the results match Linear's own search for the same text.
- [ ] Lane 4. Add a Linear issue to an existing board with **Add from tracker**. Save `l1-from-issue.png`. Pass when the orchestrator's new ticket carries the issue's description and comments and links the issue.
- [ ] Lane 5. Load a `tickets.json` whose tickets link child issues. Save `l1-ticket-chip.png`. Pass when each frame shows the key, state, and assignee Linear reports.
- [ ] Lane 6. Search the GitHub tab on the shared lane repo after opening three lane issues there. Save `l1-github.png`. Pass when all three are listed and adding one creates a linked ticket.
- [ ] Lane 7. Have a real Claude orchestrator change an issue's state in the scratch tracker twice, once through a `tracker_write` item and once by calling `set_issue_state` itself, then have a Codex orchestrator call it once. Save `l1-write.png`. Pass when every call waits for the operator with the exact change shown, **Hold** leaves the issue unchanged, and **Approve** changes it.
- [ ] Lane 8. Add a second issue to the same board. Save `l1-add.png`. Pass when the orchestrator files it as its own ticket next to the first, linked to that issue.
- [ ] Lane 9. Run the Windows app and open **Add from tracker** on the Linear tab. Save `l1-windows.png` from a full-window capture. Pass when it matches the layout of the issue picker in Orca's dialog.
- [ ] Lane 10. Run the boundary check, the standards check, and the dependency rules at head. Save `l1-checks.txt`. Pass when all three exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a keystroke in the Linear search to its results' paint.
- [ ] Probe. Log `board:issue-search` and `board:issue-results` twenty times.
- [ ] Baseline. Trunk has no search. Record the head times.
- [ ] Rule. The median stays under 300 ms, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 3, 5, and 7 screenshots into `apps/board/docs/media/l1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/l1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends L1 to the base-branch stack and the operator lands it bottom-up.

**Actuals.** L1 merged as PR #42 at `6969277d83`.

- The issue picker searches with `issues.list`. `issues.candidates` returns labels and assignees, not search results.
- The picker shows open issues only, and the UI does not say so.
- The ask rule rides on the board's own Claude instances through `--settings`, not in each folder's `.claude/settings.local.json`. A base instance's own `--settings` is replaced by it.
- Known gap, recorded by the operator: a child started on the operator's base Claude instance or on Codex can change issue state with no Approve, and agents running `gh` from Bash can close GitHub issues with no Approve.
- Codex orchestrators are blocked with a reason in the UI, because gating Codex per tool needs an engine change.
- The `tracker_write` card makes only what it shows: no host, labels, or assignees.
- Jira is not offered by T3 0.1.10.
- `vp run --filter @agent-board/app dev:web` drops `AGENT_BOARD_TOKEN`. Run `vp dev --port <port>` from `apps/board` instead.
- Perf: GitHub-tab search median 734.5 ms against the 300 ms rule, a miss the operator moved to O1. Linear search was not timed.
- Linear lanes ran in the operator's `t3-board` workspace, team T3.

## Port pstack to T3 and run the orchestrator in poteto-mode (B12)

**Depends on.** L1.

**Files.**

- [ ] Create the private repo `13kparkin/pstack-t3` with an `upstream` branch and a `main` branch, laid out like `13kparkin/pstack-omp`.
- [ ] In that repo, create `skills/pstack-t3/SKILL.md` and `scripts/sync-upstream`.
- [ ] Create `apps/board/electron/pstack.ts` and `apps/board/electron/pstack.test.ts`, and `apps/board/scripts/vendor-pstack.mjs` with its test and the vendored copies in `apps/board/pstack/`.
- [ ] Edit `apps/board/src/orchestrator/orchestratorInstance.ts`, `apps/board/src/orchestrator/brief.md`, `apps/board/src/state/orchestrator.ts`, `apps/board/roles/poteto-agent.md`, and the IPC, preload, and bridge files that carry the checkout path.

**Build.**

- [ ] Seed `upstream` from the `cursor/plugins` pstack commit that `pstack-omp`'s `upstream` branch last records, keeping its `Upstream-Commit:` trailers. Copy `scripts/sync-upstream` from `pstack-omp`. `git diff upstream main -- skills agents` is the whole T3 adaptation.
- [ ] Write `skills/pstack-t3/SKILL.md` with the same sections as `pstack-omp`'s adapter. Children start with `delegate_task` and a role, isolation, target, and title. The role map points at the board's 18-role registry. Results come from T3 thread reads and the thread family. Waiting relies on T3 waking the parent when a child finishes or asks. The human is reached through `foryou.jsonl` and `request_secret`. Claude Code's built-in subagent tool is never used.
- [ ] Change other skills only where they name OMP mechanics, the same way `pstack-omp` changed them. Mention a skill as `$pstack-t3:<name>` at the start of a word, never inside backticks, because Claude Code and Codex prefix plugin skills and T3 only expands that form. Most pstack skills refuse the Skill tool, so the adapter reads their `SKILL.md` from the checkout.
- [ ] Load `pstack-t3` only on the board's Claude instances, never as a user-scope plugin. `ensurePstack` in `electron/pstack.ts` clones the repo into `~/.agent-board/pstack-t3` in WSL and refreshes it on later starts, keeping the old checkout when a fetch fails. The orchestrator instance and a `board-agents-<instance>` instance for children set `CLAUDE_CODE_PLUGIN_DIRS` to that folder, and every role targets the agents instance. Codex does not load the skills.
- [ ] Make the orchestrator instance's appended system prompt the T3 edition of poteto-mode, the `pstack-t3` adapter, and R1's standing rules. Every other skill loads on demand.

**You see.**

- [ ] The orchestrator runs poteto-mode on T3, starts every child through the registry, loads pstack skills on demand, and keeps its rules after a compaction, and `pstack-t3` can take new pstack releases with `sync-upstream`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `electron/pstack.test.ts` covers a first start that clones, a later start that fetches, and a failed fetch that keeps the old checkout, and `orchestratorInstance.test.ts` checks that the orchestrator and agents instances carry `CLAUDE_CODE_PLUGIN_DIRS`, each with literal expected values. Run `vp test run electron/pstack.test.ts src/orchestrator/orchestratorInstance.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk's orchestrator has R1's rules only. Ask it at head which poteto-mode playbook fits a new feature. Save `b12-playbook.txt`. Pass when it names the Feature playbook and copies its steps.
- [ ] Lane 2. Give a goal that needs a review. Save `b12-review.txt`. Pass when the reviewer starts through `delegate_task` with its registry role and the orchestrator calls no OMP tool such as `task`, `hub`, or `agent://`.
- [ ] Lane 3. Ask for `$how` on a repo question. Save `b12-skill.txt`. Pass when the ported skill loads and its sections shape the answer.
- [ ] Lane 4. Run a long session, `/compact`, then ask which principle governs a test assertion. Save `b12-compact.txt`. Pass when it answers from poteto-mode without reading old session files.
- [ ] Lane 5. Run `scripts/sync-upstream` in `pstack-t3`. Save `b12-sync.txt`. Pass when it lists the upstream changes since the seed commit.
- [ ] Lane 6. Read the Codex instance's skills from the server config. Save `b12-codex-skills.txt`. Pass when the ported skills are listed.
- [ ] Lane 7. In a T3 Claude orchestrator thread, send `$pstack-t3:how` with a repo question, and have it delegate one child. Save `b12-skill-load.txt`. Pass when the skill expands from the checkout with no disk-wide search, no `~/.claude` lookup, and no refused Skill call, and the child's `CLAUDE_CODE_PLUGIN_DIRS` is the checkout.
- [ ] Lane 8. Rerun the end-to-end goal from the orchestrator end-to-end run with the port and with R1's rules only, on the same ten checks. Save `b12-eval.md`. Pass when both scores are recorded with evidence and the port scores no lower on any check.
- [ ] Lane 9. Run two T3 Codex threads in the same project, where the first states a project fact. Save `b12-codex-memory.txt`. Pass when `~/.codex/memories_v2/` holds that fact after the first thread goes idle, or record the gap if Codex never writes it.
- [ ] Lane 10. Run the boundary check and the standards check at head. Save `b12-checks.txt`. Pass when both exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from sending a message to the orchestrator's first streamed token with the larger system prompt.
- [ ] Probe. Send the same short message ten times with R1's rules and ten with the port.
- [ ] Baseline. Record the R1 times.
- [ ] Rule. The port's median stays within 1 s of R1's, recorded for O1.

**Review gate.** None. B12 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends B12 to the base-branch stack and the operator lands it bottom-up.

## Run reviews from review templates, and spend usage wisely, on the board's orchestrator (R2)

**Depends on.** L1.

**Files.**

- [ ] Edit `apps/board/src/orchestrator/brief.md`, `apps/board/src/orchestrator/brief.test.ts`, `apps/board/src/orchestrator/launch.ts`, `apps/board/src/orchestrator/roles.ts`, `apps/board/src/orchestrator/roles.test.ts`, `apps/board/roles/task.md`, `apps/board/roles/reviewer.md`, `apps/board/roles/sonic.md`, `apps/board/src/domain/board.ts`, `apps/board/src/store/localState.ts`, `apps/board/src/state/orchestrator.ts`, `apps/board/src/settings/SettingsNav.tsx`, `apps/board/src/board/OrchestratorCard.tsx`, and `apps/board/src/board/ForYouCard.tsx`.
- [ ] Create `apps/board/src/domain/reviewTemplate.ts`, `apps/board/src/domain/reviewTemplate.test.ts`, `apps/board/src/usage/usageNotice.ts`, `apps/board/src/usage/usageNotice.test.ts`, and `apps/board/src/settings/ReviewsPage.tsx`.
- [ ] Delete `apps/board/roles/thermo-nuclear-review-subagent.md` and `apps/board/roles/thermo-nuclear-code-quality-review-subagent.md`.
- [ ] In `13kparkin/pstack-t3`, edit `skills/pstack-t3/SKILL.md`, then re-vendor `apps/board/pstack/` with `apps/board/scripts/vendor-pstack.mjs`.

**Build.**

- [ ] A review template has a name, the author-check skills the builder runs before it reports code-ready, and the reviewer-lane skills the orchestrator runs after. Every template runs with the `review-loop` skill's mechanics: its finding bar, fix rounds with `git diff --shortstat`, and a For-you question to the operator after two fix rounds with findings left.
- [ ] There is one system template, "Review loop", and it is the only one. It is the `review-loop` skill as written. Its author checks are `simplify`, `no-comments`, `unslop`, and `pre-pr-reviewer`. Its lanes are `ponytail-review`, `test-evidence-review`, `security-audit` in guidance mode, and receipts, each with the skill's runs-when rule. It cannot be edited or deleted, and every board starts on it.
- [ ] Settings gets a Reviews page that lists the templates. New template opens an editor with a name field and the skills the board's Claude instance reports, the same list the slash menu uses. The operator marks each picked skill as an author check or a reviewer lane. Duplicate on the system template starts a custom template from its skills. Custom templates save in `localState.ts` under `reviewTemplates`, and their lanes run on every ticket.
- [ ] The orchestrator card has a Review menu that picks the board's template. `board.json` stores the pick as `reviewTemplate`, and no value means the system template. The launch facts name the template and its skills. A pick during a run sends the orchestrator one message naming the new template, and it applies from the next ticket.
- [ ] In `reviewTemplate.ts`, keep the pure pieces: the system template, the template schema, and the facts text a template renders.
- [ ] `brief.md` tells the orchestrator to run the board's review template on every ticket. The builder runs the author checks before it reports code-ready. The orchestrator then starts each reviewer lane that applies as its own child, collects the findings, sends the real ones back to the builder, and runs the lanes again after each fix round. The ticket's PR body comes from the `pr-description` skill.
- [ ] `roles/reviewer.md` runs one lane per child, with the skill the orchestrator names in the task.
- [ ] Delete the two thermo-nuclear roles and their `roles.ts` entries. `ponytail-review` covers bugs, broken callers, and code that should not exist, and the thermo-nuclear code-quality checklist pushes for restructuring that grows code.
- [ ] In the `pstack-t3` adapter, map every skill step that says to start a subagent, a scout, a task, or a reviewer to `delegate_task` with the matching registry role. This covers user skills such as `pre-pr-reviewer` and `no-comments`.
- [ ] The skills come from where they already load on the board's Claude instances: `pstack-t3` for `no-comments`, `unslop`, and `swarm`, `~/.claude/skills` for `review-loop`, `simplify`, `pre-pr-reviewer`, `test-evidence-review`, `security-audit`, and `pr-description`, and the user-scope ponytail plugin for `ponytail-review`. Nothing is vendored twice.
- [ ] Spend usage wisely without losing quality. Save on waste, never on the hard steps. Anthropic measured an orchestrator with subagents at about 15 times a chat's tokens, and found token use explains most of the quality difference, so cutting thinking blindly makes results worse. Sources: [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) and [Which Claude model should you build with?](https://claude.dev/blog/which-claude-model-should-you-build-with/).
- [ ] Set the role models in `roles.ts` from that guide, not from omp's settings. `reviewer` runs on Sonnet 5.5 at `medium`, for routine lanes. `security-reviewer` runs on Opus 5.5 at `high`, for security and large diffs. `task` runs on Sonnet 5.5 at `medium`. `scout` stays on Sonnet 5.5 at `medium`. `sonic` stays on Haiku 5.5 at `low`. Roles with no model of their own take Opus 5.5 at `medium`. No role uses Fable 5.1 or `xhigh`.
- [ ] `roles/sonic.md` keeps sonic off source code. It runs tests, reads logs, collects data, and moves text the task gives word for word. The guide keeps code edits off small models, and Haiku costs five times more on prompts over 100K tokens.
- [ ] `brief.md` gives the orchestrator the usage rules, always on.
  - [ ] Pick the cheapest role that can do the step.
  - [ ] When a child fails, or reports it is unsure, re-run that step once on the next tier up: Haiku, then Sonnet, then Opus, at `medium`. Never retry on the same tier. The guide measured low effort with failures re-run at high at about 97% of tasks for $0.17, against 95.3% for $0.29 with every task at high.
  - [ ] Never cut planning, a lane the board's template requires, security review on a trust boundary, live lanes, receipts, or the stop after two fix rounds.
  - [ ] Batch small work, and give one reviewer every lane on a diff of a few files. Hand over file paths, not pasted text. Ask children for short reports, because every report stays in the orchestrator's context. Send a short follow-up to a child that already holds the context. Never poll.
  - [ ] A Codex orchestrator's children all inherit its model, so lean work lowers `effort` instead of switching models.
- [ ] Send the orchestrator the usage numbers T3 already reports. The launch facts carry one line per usage window of the orchestrator's provider, such as `Claude weekly 82%, resets Fri`. When a window crosses 50, 80, or 95 percent, the board sends one message with that line. Above 80 percent the orchestrator runs lean: only the cheapest roles, and it asks the operator before starting more than two agents at once. Above 95 percent it finishes the work in flight and asks the operator before it starts any new agent.
- [ ] In `usageNotice.ts`, keep the pure pieces: the usage line a window renders, and the crossings between two readings of the windows.
- [ ] For-you card bodies render through C2's markdown in its untrusted mode, the one M1 uses for PR comments, so the tables, lists, and Mermaid graphs the orchestrator writes for a decision show as they do in chat. A body can quote issue text from a tracker, so images show as their alt text. `brief.md` tells the orchestrator to give each question the context the operator needs to decide, such as a short table of the options.

**You see.**

- [ ] The operator picks a review template for each board, or builds one from review skills. Every ticket goes through the board's template, and the orchestrator stops and asks after two fix rounds. Cheap roles do the cheap steps, and the orchestrator slows down and asks as usage limits get close.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `roles.test.ts` asserts the literal registry with the new models and without the two thermo-nuclear roles. `reviewTemplate.test.ts` asserts the system template's literal facts text, and decodes a fixed local-state file with one custom template into its literal value. `usageNotice.test.ts` turns two fixed readings into the literal messages for a window that crosses 80 percent, and no message for a window that moves without crossing. Run `vp test run src/orchestrator/roles.test.ts src/domain/reviewTemplate.test.ts src/usage/usageNotice.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. Every lane uses a real Claude orchestrator on the shared lane repo.

- [ ] Lane 1. Regression lane against trunk. Trunk's orchestrator hands a code-ready ticket to merge approval with no review lanes, so record that. Run a small goal at head on the system template. Save `r2-author-checks.txt`. Pass when the builder's transcript shows `simplify`, `no-comments`, `unslop`, and `pre-pr-reviewer` before code-ready.
- [ ] Lane 2. Save `r2-lanes.txt` from the same goal. Pass when each applicable reviewer lane starts as its own `delegate_task` child, with the `security-reviewer` role for the security lane and the `reviewer` role for the rest, every skill loads with no refused Skill call, and no Claude built-in subagent call appears.
- [ ] Lane 3. Give a goal whose builder brief plants one real bug, a comment rendered without the markdown sanitizer, and asks for three tests of made-up edge cases. Save `r2-fix-round.txt` and `r2-pr-body.txt`. Pass when a lane names the bug with `file:line`, `test-evidence-review` flags all three tests, the fix round fixes the bug and deletes the tests, reports its `git diff --shortstat`, and adds nothing its findings did not require, and the merged PR body has every `pr-description` section that applies and a Mermaid graph.
- [ ] Lane 4. Launch a board and record its launch facts. Then send the orchestrator the 80 percent message from the unit fixture, and give it a goal with five tickets. Save `r2-usage.txt`. Pass when the facts' usage lines match the board's usage bar, and after the message the orchestrator starts only the cheapest roles and asks before starting more than two agents.
- [ ] Lane 5. Create a template named "Security only" with `simplify` as its author check and `security-audit` as its lane, and pick it on a board. Run a small goal. Save `r2-custom.png` and `r2-custom.txt`. Pass when only those two skills run on the ticket.
- [ ] Lane 6. Give a docs-only goal on the system template. Save `r2-docs.txt`. Pass when the security and test lanes are skipped with their reasons.
- [ ] Lane 7. Give a goal that still has findings after two fix rounds. Save `r2-escalate.png`. Pass when a For-you question asks the operator, its body's table renders as a table, and no third fix round starts.
- [ ] Lane 8. Run the same three-ticket goal twice in fresh sessions, once with trunk's role models and once at head. Save `r2-models.txt` with each run's tokens per role from the engine's turn usage, its review verdicts, and its fix rounds. Pass when head uses fewer tokens with the same verdicts and no extra fix round, and any escalation re-ran its step exactly one tier up.
- [ ] Lane 9. Open Settings, then Reviews, and restart the app. Save `r2-templates.png`. Pass when the system template has no edit or delete, the editor lists the skills the instance reports, and the custom template and the board's pick are still there after the restart.
- [ ] Lane 10. Run the boundary check, the standards check, and the dependency rules at head. Save `r2-checks.txt`. Pass when all three exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a builder's code-ready report to a clean verdict on a one-file ticket.
- [ ] Probe. Log `board:review-start` and `board:review-clean` on five one-file tickets.
- [ ] Baseline. Trunk runs no review. Record the head times.
- [ ] Rule. The median stays under 15 minutes, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 5 and lane 9 screenshots into `apps/board/docs/media/r2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/r2-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends R2 to the base-branch stack and the operator lands it bottom-up.

## Add docs to a board as work, and show worktree setup on agent cards (A1)

**Depends on.** L1.

**Files.**

- [ ] Edit `apps/board/src/chat/Composer.tsx`, `apps/board/src/board/OrchestratorCard.tsx`, `apps/board/src/board/Viewport.tsx`, `apps/board/src/board/AgentCard.tsx`, and `apps/board/src/orchestrator/brief.md`.
- [ ] Create `apps/board/src/chat/attachments.ts`, `apps/board/src/chat/attachments.test.ts`, `apps/board/src/state/worktreeSetup.ts`, and `apps/board/src/state/worktreeSetup.test.ts`.

**Build.**

- [ ] A board's work is its tickets and its docs. The operator adds docs by attaching files in the orchestrator chat, with an attach button or by dropping files onto the composer or the board. The composer sends them as T3 chat attachments, images and other files alike, the way T3 web's `apps/web/src/components/chat/ChatComposer.tsx` does, read only. T3's own limits apply: 100 files per message, 50 MiB per file, 10 MiB per image, and 80 MiB of images per message.
- [ ] Dropping files onto the board sends one orchestrator message, "Add these docs to the board's work", with the files attached.
- [ ] The orchestrator card lists the board's docs by name, from the attachments in its thread. It shows one row per doc and a count.
- [ ] `brief.md` tells the orchestrator to read every attached doc before it plans, to cite the doc a ticket comes from, and to organize docs into tickets the same way it does issues.
- [ ] In `attachments.ts`, keep the pure pieces: turn dropped files into T3 attachment inputs, and check them against T3's limits before sending.
- [ ] Show each worktree agent's setup on its agent card, as Orca shows it. Subscribe to T3's `subscribeWorktreeSetup` for the agent's thread. While the phase is `running`, the card shows the current stage's label from `worktreeSetupStageLabel` and its percent when T3 sends one. When the phase is `failed`, the card shows the failed stage, T3's error, the last three lines of that stage's `tail`, and **Open terminal** for the setup script's `terminalId` when it has one. When the phase is `done`, the line goes away. Today the board never reads this stream, so a failing setup script shows nowhere.
- [ ] In `worktreeSetup.ts`, keep the pure piece: the card line a setup snapshot renders.

**You see.**

- [ ] The operator drops a spec onto a board, the orchestrator card lists it, and the orchestrator files tickets that cite it.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `attachments.test.ts` turns a fixed markdown file and a fixed PNG into literal attachment inputs, and rejects a file over T3's 50 MiB limit with T3's own message. `worktreeSetup.test.ts` turns a fixed running snapshot and a fixed failed snapshot into their literal card lines. Run `vp test run src/chat/attachments.test.ts src/state/worktreeSetup.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. Every lane uses a real Claude orchestrator.

- [ ] Lane 1. Regression lane against trunk. Trunk's composer sends no attachments, so record that fact. Attach a markdown spec and a screenshot with the button at head. Save `a1-attach.png`. Pass when the message carries both files, the orchestrator quotes a line from the spec, and it describes what the screenshot shows.
- [ ] Lane 2. Drop a PDF onto the board. Save `a1-drop.png`. Pass when one orchestrator message carries it and the orchestrator card lists it.
- [ ] Lane 3. Set the lane project's setup script in Settings, then Worktrees, to a command that prints three lines and exits 1, and start one worktree agent. Then set a script that succeeds, and start another. Save `a1-setup-failed.png`, `a1-setup-running.png`, and `a1-setup.txt` with T3's raw snapshots. Pass when the first card shows the failed stage, T3's error, and the script's last lines, the second card shows each stage as it runs, and its line goes away when setup is done.
- [ ] Lane 4. Give a board a goal and a two-page spec. Save `a1-tickets.txt`. Pass when the orchestrator's tickets each cite the spec.
- [ ] Lane 5. Add one Linear issue and one doc to the same board. Save `a1-mixed.png`. Pass when both turn into tickets on the board.
- [ ] Lane 6. Reopen the board. Save `a1-reopen.png`. Pass when the orchestrator card still lists every doc.
- [ ] Lane 7. Attach a file over 50 MiB. Save `a1-limit.png`. Pass when the board shows T3's limit message and sends nothing.
- [ ] Lane 8. Start a child agent on a ticket that cites a doc. Save `a1-child.txt`. Pass when the child reads the doc by its path.
- [ ] Lane 9. Run the Windows app and drop a file from Windows Explorer onto the board. Save `a1-windows.png` from a full-window capture. Pass when it attaches the same way as in lane 2.
- [ ] Lane 10. Run the boundary check, the standards check, and the dependency rules at head. Save `a1-checks.txt`. Pass when all three exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from dropping a 1 MiB file to its chip showing in the composer.
- [ ] Probe. Log `board:attach-drop` and `board:attach-shown` ten times.
- [ ] Baseline. Trunk has no attachments. Record the head times.
- [ ] Rule. The median stays under 200 ms, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 2, 4, and 6 screenshots into `apps/board/docs/media/a1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/a1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends A1 to the base-branch stack and the operator lands it bottom-up.

## Open tickets and agents in the right sidebar, not a drawer (P1)

**Depends on.** R2 and A1.

**Files.**

- [ ] Edit `apps/board/src/browser/panel.ts`, `apps/board/src/browser/PanelTabs.tsx`, `apps/board/src/browser/PanelHost.tsx`, `apps/board/src/board/BoardScreen.tsx`, `apps/board/src/state/boardUi.ts`, and every caller that opens the peek.
- [ ] Move `apps/board/src/board/PeekDrawer.tsx` to `apps/board/src/board/TicketPanel.tsx`.

**Build.**

- [ ] Clicking a card never opens a second sidebar. Remove the peek drawer that floats over the canvas's right edge.
- [ ] Add a **Ticket** tab to the right sidebar, after Chat. It draws the content the drawer drew: the ticket's summary and why, M1's check rows, the readiness checklist, and the chosen agent's log. It draws into the panel the same way Chat and Checks do, through a slot.
- [ ] Clicking a ticket frame or an agent card opens the right sidebar when it is closed, and shows the Ticket tab for that ticket and agent. An unassigned agent shows as "Unassigned" with its log. With nothing chosen, the tab says "Select a ticket or agent card".
- [ ] The choice stays when the operator switches to another tab and back, and clears when the board changes.

**You see.**

- [ ] One right sidebar. A card's details open in its Ticket tab, and the canvas is never covered.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] No new unit test. The change moves UI, and the panel's tab rules already have tests. Run `vp test run` from `apps/board`, and it passes.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk opens the peek drawer over the canvas, so record that. Click a ticket frame at head. Save `p1-ticket.png`. Pass when the right sidebar shows the Ticket tab and no drawer element exists.
- [ ] Lane 2. Click an agent card. Save `p1-agent.png`. Pass when the Ticket tab shows that agent's log.
- [ ] Lane 3. Click an unassigned agent. Save `p1-unassigned.png`. Pass when the tab reads "Unassigned" with its log.
- [ ] Lane 4. Close the sidebar, then click a card. Save `p1-reopen.png`. Pass when the sidebar opens on the Ticket tab.
- [ ] Lane 5. Switch to Chat and back. Save `p1-keep.txt`. Pass when the same ticket and agent show.
- [ ] Lane 6. Open another board. Save `p1-clear.png`. Pass when the tab says "Select a ticket or agent card".
- [ ] Lane 7. Open a ticket with a pull request. Save `p1-checks.txt`. Pass when the tab's check rows equal the card's and the Checks tab's.
- [ ] Lane 8. Open an agent card whose worktree setup failed. Save `p1-setup.png`. Pass when the failure panel shows uncovered, and Open terminal works.
- [ ] Lane 9. Run the Windows app and click a ticket. Save `p1-windows.png` from a full-window capture. Pass when the Ticket tab matches lane 1.
- [ ] Lane 10. Run the boundary check, the standards check, and the dependency rules at head. Save `p1-checks-run.txt`. Pass when all three exit 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from clicking a card to the Ticket tab's first paint.
- [ ] Probe. Log `board:ticket-open` and `board:ticket-painted` ten times.
- [ ] Baseline. Trunk's drawer, timed the same way.
- [ ] Rule. The median stays within 20 ms of trunk's, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 1, 2, and 4 screenshots into `apps/board/docs/media/p1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/p1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P1 to the base-branch stack and the operator lands it bottom-up.

## Ship Windows releases of the board from GitHub (G1)

**Depends on.** P1.

**Files.**

- [ ] Edit `.github/workflows/agent-board.yml`, `apps/board/package.json`, `pnpm-lock.yaml`, and `apps/board/README.md`.
- [ ] Create `apps/board/electron-builder.yml`, `apps/board/scripts/release-notes.mjs`, and `apps/board/scripts/release-notes.test.mjs`.

**Build.**

- [ ] First find out why GitHub creates no Actions runs on `13kparkin/t3code` since 2026-11-20 22:24 UTC. The repo is public, Actions is enabled with all actions allowed, and `agent-board` is active, yet no pull request since has a run. Add `workflow_dispatch` to `agent-board.yml`, and dispatch it once on a branch. Record what GitHub does in the PR body. If GitHub still creates no run, stop and tell the operator what was checked, because the release job cannot work without runs.
- [ ] Package the board with `electron-builder` at the version T3's `apps/desktop` already uses, 26.16.1, so the lockfile gains no new copy. `electron-builder.yml` builds two Windows x64 artifacts from `dist/` and `dist-electron/`: an NSIS installer `Agent-Board-Setup-<version>.exe` that adds a Start menu and desktop shortcut, and a portable `Agent-Board-<version>-win-x64.zip`. There is no code signing, so Windows SmartScreen warns on first run. There is no auto-update.
- [ ] Add a `release` job to `agent-board.yml` that runs only on `workflow_dispatch`, with a `version` input such as `0.1.0` and a `prerelease` checkbox. It runs on `windows-latest`, runs the same gates as the `agent-board` job, builds, packages, and creates the GitHub release `board-v<version>` on the dispatched commit. It attaches the installer, the zip, and `SHA256SUMS`. Only this job gets `contents: write`. A version whose tag exists fails before building.
- [ ] Write release notes the way T3's `release.yml` does in its "Write release notes" step with `scripts/generate-release-notes.ts`: a short model summary on top of GitHub's full generated list. `release-notes.mjs` finds the previous `board-v*` tag, asks GitHub for its generated notes from that tag to this one through `gh api repos/{repo}/releases/generate-notes`, and reads each listed PR's title and body. It asks Claude Sonnet 5.5 at `medium` effort for a short summary of what changed for the operator, then writes `release-notes.md` as the summary followed by GitHub's list. The step uses the `ANTHROPIC_API_KEY` repo secret, and runs with `continue-on-error`, like T3's. With no secret, no previous tag, or a failed call, the release uses GitHub's generated notes alone. The first release has no previous tag, so its notes list everything up to it.
- [ ] Turn off the upstream workflows that cannot run in this fork, such as T3's nightly `Release`, with `gh workflow disable`, because they need upstream's secrets and would fail on a schedule. This changes repo settings, not files. List each one in the PR body.
- [ ] `README.md` says how to download and install a release, and how to cut one with `gh workflow run agent-board.yml -f version=<version>`.

**You see.**

- [ ] The repo's Releases page lists Agent Board releases with an installer and a zip, and the operator cuts one from the Actions tab or one command.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `release-notes.test.mjs` picks the previous tag from a fixed tag list (`board-v0.1.0`, `board-v0.2.0`, and a `v0.1.11` from upstream, giving `board-v0.1.0` for `board-v0.2.0`), and joins a fixed summary and a fixed GitHub list into the literal `release-notes.md`. Run `node --test apps/board/scripts/release-notes.test.mjs`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Live lanes run the real workflow on the fork and install on this Windows machine. Each release made by a lane is a pre-release named `board-v0.0.<n>-test`, deleted at cleanup.

- [ ] Lane 1. Dispatch `agent-board.yml` on the PR branch. Save `g1-dispatch.txt` with `gh run list` output. Pass when GitHub creates a run and the gates pass.
- [ ] Lane 2. Dispatch the release job with a test version. Save `g1-release.txt` with `gh release view --json assets,body`. Pass when the release has the installer, the zip, and `SHA256SUMS`, and its body has the summary over GitHub's list when the secret is set, or GitHub's list alone when it is not.
- [ ] Lane 3. Download both artifacts and check them against `SHA256SUMS`. Save `g1-sums.txt`. Pass when both match.
- [ ] Lane 4. Run the installer on Windows. Save `g1-install.png`. Pass when the Start menu and desktop shortcuts exist.
- [ ] Lane 5. Open the installed app from its desktop shortcut. Save `g1-launch.png`. Pass when the sidebar footer shows the engine connected, with no WSL command typed.
- [ ] Lane 6. Create a board in the installed app and send the orchestrator one message. Save `g1-board.png`. Pass when it answers, so pstack and the engine both load from an installed app.
- [ ] Lane 7. Unzip the portable zip and run it. Save `g1-portable.png`. Pass when it opens as in lane 5.
- [ ] Lane 8. Dispatch again with the same version. Save `g1-dup.txt`. Pass when the job fails before building and names the existing tag.
- [ ] Lane 9. Uninstall from Windows settings. Save `g1-uninstall.txt`. Pass when the app folder and both shortcuts are gone, and the board's own data folder is left alone.
- [ ] Lane 10. Run the boundary check, the standards check, and the dependency rules at head. Save `g1-checks.txt`. Pass when all three exit 0.
- [ ] Cleanup. Delete every test release and its tag, uninstall, and remove downloaded files.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from launching the installed app to `board:first-paint`.
- [ ] Probe. Launch it ten times and read the `board:first-paint` line.
- [ ] Baseline. `start:windows` from WSL, timed the same way.
- [ ] Rule. The installed app's median is no slower than the baseline's, recorded for O1.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 4 and lane 5 screenshots into `apps/board/docs/media/g1-review-<slug>.png`.
- [ ] Post them in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends G1 to the base-branch stack and the operator lands it bottom-up.
- [ ] After merge, the root cuts `board-v0.1.0` from `main`.

## Meet every recorded speed budget (O1)

**Depends on.** B12 and G1.

**Files.**

- [ ] Create `apps/board/docs/perf-ledger.md` with one row per PR, holding the metric, the rule, every recorded number, and pass or miss.
- [ ] Edit only the `apps/board` files that the ledger's misses point to. Name each one in the ledger row before you change it.

**Build.**

- [ ] Fill the ledger from every PR's saved perf evidence under `/tmp/swarm-<pr-id>/` and the PR bodies.
- [ ] Profile each miss before changing code. Record the cause in its ledger row, for example the 2.5 MB main bundle or the `t3 --version` call on each start that B2 measured.
- [ ] Fix each miss with the smallest change that meets its rule, then rerun that PR's perf probe and record the new numbers.

**You see.**

- [ ] Every row in `perf-ledger.md` reads pass, with its before and after numbers.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Every test that covers a changed file still passes, and each new cache or lazy path gets one test that asserts its observable result. Run `vp test run` on those files from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run B1's first-paint probe at trunk and head. Save `o1-first-paint.txt`. Pass when the head median meets B1's rule.
- [ ] Lane 2. Run B2's engine-connected probe. Save `o1-engine-connected.txt`. Pass when the median meets B2's rule.
- [ ] Lane 3. Run B5's sidebar render probe with 20 projects and 20 boards each. Save `o1-sidebar.txt`. Pass when the median meets B5's rule.
- [ ] Lane 4. Run B6's token paint probe. Save `o1-token-paint.txt`. Pass when the p95 meets B6's rule.
- [ ] Lane 5. Run B7's board render and pan probes. Save `o1-board.txt`. Pass when both meet B7's rules.
- [ ] Lane 6. Run B8's For-you click and file probes. Save `o1-foryou.txt`. Pass when both p95s meet B8's rules.
- [ ] Lane 7. Run B9's artifact list probe on 300 files. Save `o1-artifacts.txt`. Pass when the median meets B9's rule and only visible thumbnails load.
- [ ] Lane 8. Run B10's PR chip probe. Save `o1-pr-chip.txt`. Pass when the p95 meets B10's rule.
- [ ] Lane 9. Run B11's browser panel probe. Save `o1-browser.txt`. Pass when the median meets B11's rule.
- [ ] Lane 10. Run the board app end to end on Windows against the WSL service, using a board, an orchestrator, and two tickets. Save `o1-end-to-end.png`. Pass when every flow from B2 to B12 still works.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Every metric in the ledger.
- [ ] Probe. Each PR's own probe, rerun at the O1 head.
- [ ] Baseline. The numbers each PR recorded at its merge.
- [ ] Rule. Every ledger row meets its PR's rule, and no row gets slower than its recorded baseline.

**Review gate.** None. O1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends O1 to the base-branch stack and the operator lands it bottom-up.

## Send tickets or a whole board to the cloud, on Warp or Claude, and work with them from the board (X1)

**Depends on.** O1.

**Files.**

- [ ] Create `apps/board/electron/warp.ts`, `apps/board/electron/warp.test.ts`, and `apps/board/electron/claudeCloud.ts`.
- [ ] Create `apps/board/src/warp/WarpCard.tsx`, `apps/board/src/warp/SendToWarp.tsx`, `apps/board/src/warp/WarpBadge.tsx`, and `apps/board/src/warp/WarpTaskTab.tsx`.
- [ ] Create `apps/board/src/warp/warpTasks.ts`, `apps/board/src/warp/warpTasks.test.ts`, and `apps/board/docs/cloud-review.md`.
- [ ] Edit L1's `apps/board/src/settings/IntegrationsPage.tsx`, `apps/board/src/board/TicketFrame.tsx`, `apps/board/src/board/OrchestratorCard.tsx`, `apps/board/src/files/MainTabs.tsx`, `apps/board/src/domain/ticket.ts`, `apps/board/src/domain/board.ts`, `apps/board/src/domain/forYou.ts`, `apps/board/src/orchestrator/brief.md`, and the IPC, preload, and bridge files that carry Warp calls.

**Build.**

- [ ] Call the Warp Platform API at `https://app.warp.dev/api/v1` from the main process in `electron/warp.ts`, with `fetch` and no SDK. Warp is the one outside service the board calls itself, because T3 has no Warp support. Take paths and fields from Warp's OpenAPI spec at `https://docs.warp.dev/openapi.json`, and record the spec's date in the client. The API key lives in the board's `safeStorage` token store. It never reaches the renderer, the engine, an agent, chat, or a log, and no agent gets Factory MCP, because a Warp key has no read-only or per-factory scope.
- [ ] Add a **Warp** card to L1's Integrations page in Orca's card style, copied from `src/renderer/src/components/integrations/task-trackers/linear-integration-card.tsx` and `linear-api-key-dialog.tsx` in Orca's source. Connect takes the key, lists the account's factories from `GET /factory`, and Disconnect deletes the key.
- [ ] Only the operator sends work to Warp, from the UI. The orchestrator never sends and never proposes a send.
- [ ] Add **Send to Warp** to the ticket frame's menu. It opens a dialog with a factory picker searched through `GET /factory?search=`, and a title and prompt filled from the ticket's goal, with L1's linked issue as `ticket_ref` (for example `linear:XEO-123`) and `ticket_url`. Send calls `POST /factory/{uid}/runs` and stores the factory, task, and run IDs in an optional `warp` field on the ticket.
- [ ] Add **Send board to cloud** to the orchestrator card. Its dialog picks a target, a Warp factory or a Claude cloud orchestrator, and fills the prompt with the board's goal and every open ticket's title, goal, and linked issue. A Warp send dispatches one run and stores the factory and run IDs in an optional `warp` field in `board.json`. The board then shows the factory's tasks from that run as frames with Warp badges. Before building this, dispatch one run in the test factory and record in `cloud-review.md` how the foreman's tasks link back to that run.
- [ ] A Claude cloud send runs on the operator's Claude subscription, through the `claude` CLI from the main process in `electron/claudeCloud.ts`. It runs `claude --cloud "<prompt>"` in the project's checkout with the operator's claude.ai login, and stores the session ID and URL in an optional `cloud` field in `board.json`. Sources: [Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web).
  - [ ] The prompt carries the brief's rules and facts, plus one more rule: after every write to `tickets.json` or `foryou.jsonl`, commit the board folder and push it to the branch `agentboard/<board slug>`.
  - [ ] The board reads that branch from the main process with `git fetch` and `git show`, every 10 s while the board is visible, and shows its tickets, lanes, and For-you cards as it does for a local board.
  - [ ] Answering a card sends `claude -p "<the card's answer message>" --cloud <session id> --output-format json`, and the card shows the send failed when the result has `ok: false`.
  - [ ] **Open in Claude** opens the session's URL in B11's panel, where the operator sees the conversation and answers the session's own approvals.
  - [ ] Before building this target, run one small cloud session on the lane repo. Record in `cloud-review.md` whether the session can push the store branch, whether a follow-up reaches it, whether `claude --cloud <session id>` attach can stream its events, and whether `claude agents --json` or `/tasks` lists it. If the push or the follow-up fails, drop this target and tell the operator.
- [ ] `brief.md` tells the orchestrator that a ticket with a `warp` field, or every ticket on a board sent to the cloud, runs there. It starts no local agent on that work and plans the rest around it.
- [ ] Research how cloud tickets get reviewed before building that part. Compare Warp's own Review stage, R2's review templates, and whether the review skills reach Warp's agents and Claude cloud sessions from the repo. Cloud sessions read the repo's `.claude/`, not `~/.claude`. Record the findings and a proposed fit in `cloud-review.md`, and bring it to the operator for a decision.
- [ ] In `WarpBadge.tsx`, show a sent ticket's task state from `GET /factory/{uid}/tasks/{task_uid}` on its frame. Poll every 10 s while the board is visible, and stop while it is hidden. A pull request the task opens shows as B10's PR chip, so checks and merge readiness work as they do for a local ticket.
- [ ] In `WarpTaskTab.tsx`, open a main-view tab per Warp task. It shows the conversation from `GET /agent/runs/{runId}/conversation` through C2's markdown, a reply box that calls `POST /agent/runs/{runId}/followups`, **Interrupt** through `POST /agent/runs/{runId}/interrupt`, **Stop** through `POST /factory/{uid}/tasks/{task_uid}/cancel`, and **Open in Warp**, which opens the run's session link in B11's panel.
- [ ] Turn the factory inbox from `GET /factory-inbox` into For-you cards for this board's tasks, such as a foreman's plan-review question. Answering sends a follow-up and marks the notification read through `POST /factory-inbox/notifications/read`.
- [ ] In `warpTasks.ts`, keep the pure pieces: map task and run states to the frame's badge, build the dispatch body from a ticket or a board, and turn inbox notifications into For-you items.

**You see.**

- [ ] Settings connects Warp. The operator sends a ticket to a Warp factory, or a whole board to Warp or to a Claude cloud orchestrator, from the UI. The board shows each task's state, conversation, questions, and pull request, with reply, interrupt, and stop on Warp, and tickets, For-you cards, and pull requests on Claude cloud.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `warpTasks.test.ts` maps fixed task and run states to literal badges, builds literal `POST /factory/{uid}/runs` bodies from a fixed ticket with a Linear issue and from a fixed board, and turns fixed inbox notifications into literal For-you items. `electron/warp.test.ts` runs the client against a local HTTP server and checks the bearer header, the error text for a rejected key and for missing credits, and that no error message contains the key. Run `vp test run src/warp/warpTasks.test.ts electron/warp.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. The operator creates one test factory in Warp's web app connected only to `13kparkin/agent-board-lanes`, installs the Claude GitHub App on that repo, and enters the Warp key into the board's Warp card when the lane asks. Lanes share one small dispatched task per target, to keep credit and subscription use low.

- [ ] Lane 1. Regression lane against trunk. Trunk has no Warp card, so record that fact. Connect Warp at head, then enter a revoked key. Save `x1-connect.png` and `x1-bad-key.png`. Pass when the card lists the factories `GET /factory` returns, the key appears in no board file, log, or renderer storage, and the revoked key is rejected with nothing dispatched.
- [ ] Lane 2. Send a ticket from its frame menu on a board with a real Claude orchestrator. Save `x1-send.png`. Pass when exactly one task carries the ticket's `ticket_ref`, and the orchestrator starts no local agent on that ticket.
- [ ] Lane 3. Watch the sent ticket, then stop it. Save `x1-status.png` and `x1-stop.txt`. Pass when its badge follows the task through at least two states that match the API, with no reload, and the API reports it stopped and the badge shows it.
- [ ] Lane 4. Reply in the Warp tab. Save `x1-reply.png`. Pass when the follow-up appears in the run's conversation from the API and the foreman responds to it.
- [ ] Lane 5. Answer a foreman question from its For-you card. Save `x1-needs-you.png`. Pass when the card matches the inbox item, the answer reaches the conversation, and the notification reads as read.
- [ ] Lane 6. Let the task open its pull request on the lane repo. Save `x1-pr.png`. Pass when the PR chip and its checks match `gh pr view`.
- [ ] Lane 7. Send a two-ticket board to a Claude cloud orchestrator. Save `x1-claude-cloud.png` and `x1-claude-cloud.txt`. Pass when the board's frames and For-you cards match the pushed `agentboard/<board slug>` branch, an answered card reaches the session as a follow-up, and the session's pull request shows as a PR chip.
- [ ] Lane 8. Send a two-ticket board to a Warp factory from the orchestrator card. Save `x1-board.png`. Pass when the factory's tasks from that run show as frames whose badges match `GET /factory/{uid}/tasks`, and the orchestrator starts no local agent.
- [ ] Lane 9. Run the Windows app with a Warp tab open beside the board. Save `x1-windows.png` from a full-window capture. Pass when the tab fits beside the board and the Warp card matches Orca's integration cards.
- [ ] Lane 10. Run the boundary check, the standards check, and the dependency rules at head. Save `x1-checks.txt`. Pass when all three exit 0.
- [ ] Cleanup. Stop the test task, archive the Claude cloud session, close their pull requests and delete their branches on the lane repo, disconnect Warp in the board, and tell the operator to revoke the key.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from opening a Warp tab to its conversation's first paint, minus the network time the main process logs.
- [ ] Probe. Log `board:warp-open`, `board:warp-response`, and `board:warp-painted` ten times on a conversation of 200 messages.
- [ ] Baseline. Trunk has no Warp tab. Record the head times.
- [ ] Rule. The median, minus network time, stays under 200 ms. A miss is fixed in this PR, because O1 runs before it.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 2, 5, and 8 screenshots into `apps/board/docs/media/x1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/x1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends X1 to the base-branch stack and the operator lands it bottom-up.

## Run Orca-style bots on T3's scheduled tasks (Y1)

**Depends on.** O1.

**Files.**

- [ ] Create `apps/board/src/bots/BotsScreen.tsx`, `apps/board/src/bots/NewBotDialog.tsx`, `apps/board/src/bots/BotHomeChat.tsx`, `apps/board/src/bots/BotSettings.tsx`, `apps/board/src/bots/BotTriggers.tsx`, and `apps/board/src/bots/BotAvatar.tsx`.
- [ ] Create `apps/board/src/bots/botModel.ts` and `apps/board/src/bots/botModel.test.ts`.
- [ ] Create `apps/board/electron/botHome.ts` and `apps/board/electron/botHome.test.ts`.
- [ ] Edit `apps/board/src/sidebar/Sidebar.tsx`, `apps/board/src/settings/SettingsNav.tsx`, `apps/board/src/domain/forYou.ts`, `apps/board/src/orchestrator/orchestratorInstance.ts`, and the IPC, preload, and bridge files that carry bot home calls.

**Build.**

- [ ] Port the bot screens from Orca's source at `/home/kyle/personalDev/main/artifacts/orca-src`, read only: `src/renderer/src/components/bots/BotFirstScreen.tsx`, `BotCreateButton.tsx`, `NewBotDialog.tsx`, `BotHomeChat.tsx`, `BotChatsPanel.tsx`, `BotChatTreeWorkerRow.tsx`, `BotNeedsYouSection.tsx`, `BotActivityPanel.tsx`, and `BotAvatar.tsx`, the mascots in `src/renderer/src/assets/bot-mascot-cutouts/`, and `src/renderer/src/components/settings/bots/BotsSettingsPane.tsx`, `BotSoulEditor.tsx`, and `BotMemoryList.tsx`. Keep Orca's MIT notice with the copied mascots. Rewire every call to T3's contracts.
- [ ] Add **Bots** to the left sidebar. The Bots screen lists each bot with its avatar, its home chat, the chats its triggers started, its workers, and what it needs from the operator, as Orca's does.
- [ ] A bot is a T3 thread on the board's agents instance, with a home folder at `~/.agent-board/bots/<slug>/` in WSL holding `SOUL.md` and `MEMORY.md`. `electron/botHome.ts` creates and reads that folder through the WSL shell, as `electron/pstack.ts` does. The bot's appended prompt tells it to read `SOUL.md` first and keep `MEMORY.md` current. Port that prompt from Orca's bot preamble in `src/main/bots/`, with every Orca CLI command replaced by its T3 equivalent, `delegate_task`, T3's issue tools, or `gh`.
- [ ] The new-bot dialog takes a name, an avatar, a model through C1's picker, the project it works in, and a template from Orca's `src/shared/bots/bot-template-catalog/`. Offer only the templates whose tools exist on T3, and drop the Slack, Google, and Composio ones.
- [ ] Run triggers through T3's scheduled tasks with `scheduledTasks.subscribe`, `upsert`, `setEnabled`, `delete`, `runNow`, `rotateWebhookToken`, and `listWebhookDeliveries`. Offer every N minutes, a time of day on chosen weekdays, once, and webhook. Home-chat runs use `threadMode: continue`, and per-event runs use `new_thread`.
- [ ] Offer two webhook presets. GitHub signs with `x-hub-signature-256`, hex, prefix `sha256=`, with filters for events such as an opened pull request or a failed check. Linear signs with `linear-signature`, hex, no prefix, with filters on type and action. Show the webhook URL once with a copy button, because T3 returns it only on creation, and show the delivery log. Show T3 Connect's reachability beside every webhook trigger, and when it is unreachable, say that outside services can't reach the hook.
- [ ] Let people ask a bot the way Orca's **How to ask** line shows, within T3's filter operators `equals`, `notEquals`, and `startsWith`. On GitHub, a comment that starts with `@<bot>` or the label `bot:<bot>` starts it. On Linear, the label `bot:<bot>` starts it. A mention in the middle of a comment does not, because T3 has no contains filter.
- [ ] Copy Orca's **Who can ask**. Every webhook trigger carries a sender filter that defaults to the operator's own GitHub login or Linear user. Adding a person adds a copy of the trigger with their filter, because all of a T3 task's filters must match. A delivery from anyone else never starts the bot, because a request runs on the operator's machine and sign-ins.
- [ ] A bot hands code work to children through `delegate_task`. They show under the bot as Orca's worker rows and as cards on their board.
- [ ] A bot's approvals and questions arrive in B8's For-you lane with the bot's avatar. Tracker writes follow L1's `tracker_write` rule and K2's approval rule, so a bot never writes to a tracker without the operator, including its replies where it was asked, which wait as Orca's **Ask for approval** mode does.
- [ ] Out of scope, with the reason shown in the Bots screen's help: Slack triggers, because Orca's event service for Slack, Linear, and GitHub is hosted by Orca and is not in its source; Google and Composio connectors; the mobile app; bot groups.
- [ ] In `botModel.ts`, keep the pure pieces: turn a bot's triggers into `scheduledTasks.upsert` inputs, hold the two webhook presets, and join scheduled tasks and threads into bot rows.

**You see.**

- [ ] A Bots screen like Orca's, where a bot with its own soul and memory chats with the operator, runs on a schedule or a GitHub or Linear webhook, hands code work to workers, and asks the operator before any tracker write.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `botModel.test.ts` turns a fixed bot with an interval trigger, a weekday trigger, and a GitHub webhook trigger into literal `scheduledTasks.upsert` inputs, checks both webhook presets literally, and joins fixed scheduled tasks and threads into literal bot rows. `electron/botHome.test.ts` checks the slug for two bots with the same name and the files a new bot's folder gets. Run `vp test run src/bots/botModel.test.ts electron/botHome.test.ts` from `apps/board`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes at the PR head, per the boot recipe. Webhook lanes use the lane repo only, and never create a webhook in the operator's Linear workspace.

- [ ] Lane 1. Regression lane against trunk. Trunk has no Bots screen, so record that fact. Create a bot from a template at head. Save `y1-create.png`. Pass when its thread exists on the agents instance, its folder holds `SOUL.md` and `MEMORY.md`, and the screen matches Orca's ported layout.
- [ ] Lane 2. Tell the bot a fact in its home chat, start a fresh session, and ask for it. Save `y1-memory.txt`. Pass when `MEMORY.md` holds the fact and the bot answers from it.
- [ ] Lane 3. Add a once trigger two minutes ahead. Save `y1-once.png`. Pass when the run lands in the home chat on time and reads succeeded.
- [ ] Lane 4. Add a two-minute interval trigger, let it run twice, then turn it off. Save `y1-interval.txt`. Pass when it ran twice and not again after it was turned off.
- [ ] Lane 5. Add a GitHub webhook trigger, add that hook to the lane repo with its secret, and comment `@<bot>` on a lane pull request. Save `y1-github-hook.png`. Pass when the delivery is verified and matched, the bot runs in a new chat and asks to reply on the pull request, **Approve** posts the reply, a delivery with a wrong signature is rejected, and the same comment from a sender who is not on **Who can ask** starts nothing. When T3 Connect is unreachable, send the same signed deliveries to the engine's local hook URL and record the public path NOT RUN with the blocker.
- [ ] Lane 6. Send a delivery in Linear's format, signed with the trigger's secret, to the engine's hook URL. Save `y1-linear-hook.txt`. Pass when it is verified and matched, and a wrong signature is rejected.
- [ ] Lane 7. Ask the bot to fix a small thing in the lane repo. Save `y1-worker.png`. Pass when it starts a child through `delegate_task`, the worker row and card appear, and the child's pull request opens on the lane repo.
- [ ] Lane 8. Have the bot ask to comment on a lane issue. Save `y1-needs-you.png`. Pass when the For-you card carries the bot's avatar and the exact change, **Hold** leaves the issue unchanged, and **Approve** posts the comment.
- [ ] Lane 9. Run the Windows app on the Bots screen. Save `y1-windows.png` from a full-window capture. Pass when the layout matches the Orca source it was ported from.
- [ ] Lane 10. Run the boundary check, the standards check, and the dependency rules at head. Save `y1-checks.txt`. Pass when all three exit 0.
- [ ] Cleanup. Delete the test bots, their scheduled tasks and folders, the lane repo webhook, and the lane pull requests, issues, and branches.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from opening the Bots screen with 20 bots and 200 chats to its first paint.
- [ ] Probe. Log `board:bots-open` and `board:bots-painted` ten times.
- [ ] Baseline. Trunk has no Bots screen. Record the head times.
- [ ] Rule. The median stays under 200 ms. A miss is fixed in this PR, because O1 runs before it.

**Review gate.** The operator reviews at merge.

- [ ] Copy lane 1, 5, and 8 screenshots into `apps/board/docs/media/y1-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change from a lane. Save it as `apps/board/docs/media/y1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator at merge.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends Y1 to the base-branch stack and the operator lands it bottom-up.

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
- A child engine that the board boots and owns lost, because only one server can hold a T3 home's ownership lock, and current T3 desktop then refuses to start (`apps/desktop/src/backend/DesktopBackendPool.ts:249-258`). T3 desktop as the owner lost, because it is not installed here and brings its own UI. T3's background service is the same engine with no UI, and T3 updates it.
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

- `packages/client-runtime` and `packages/shared` have no stable API. An upstream merge can break the board build. Every owner runs `vp run --filter @agent-board/app typecheck` after merging upstream, and the fix always lands in `apps/board`.
- Electron lanes run on the Windows PC and depend on WSL's mirrored networking, which `.wslconfig` sets today. If it changes to NAT, the app can't reach the WSL engine or Vite server on 127.0.0.1, and the lanes fail until it is set back.
- If T3 desktop is installed later, it refuses to start on the `~/.t3` the service holds. Its fix is T3's own, documented in `docs/user/remote-access.md:540-544`. Turn the desktop's **Local environment** off, and it uses the service on the same home.
- B4's update lanes need systemd user services in WSL. If they are missing, B4 records the gap and proves the update path on a machine that has them.
- CLI sessions from `t3 auth session issue` never renew. B2 mints a new token on the first 401.
- The board builds against upstream `main`, which can move ahead of the newest T3 release. Today both are `0.1.10`, and nightly is `0.1.11`. If a merge from upstream raises the protocol the client needs past the latest release, even an updated service is too old. Merge upstream at release tags when that happens.
- The orchestrator can write a malformed store file. B5, B7, B8, and B9 parse every file at the boundary, keep the last valid state, and show a banner.
- T3 cannot limit a child's tools. Read-only roles such as `scout`, `reviewer`, and `security-reviewer` stay read-only only because their role file says so. B12 lane 7 reads the reviewer child's thread and fails when it shows an edit.
- Lanes in B3, B6, B8, B12, X1, and Y1 use the operator's Claude Code and Codex subscriptions, which costs usage. X1's lanes also spend Warp credits. Run them once per head.
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
