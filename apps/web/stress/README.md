# Stress rig

`vp run stress` puts a production build of T3 Code under concurrent load and records how the page holds up. It finds performance work; it is not a CI gate.

## What a run does

1. Builds `apps/web/dist` in production mode without minification, so profiles name real functions. `--skip-build` reuses the last build.
2. Starts a server on a fresh home in `.t3/stress/home` (never your real data) with the `Replay (dev)` provider and a scratch git project.
3. Starts `--threads` threads (default 5) on the Replay `stress` scenario, each with `--turns-per-thread` turns queued (default 4). Every turn thinks, plans, reads, asks for an edit approval, prints long terminal output, and streams a long Markdown reply through the server's default paragraph streaming.
4. Opens headless Chromium, pairs, and for `--duration` seconds (default 60) acts like a busy user: switches threads, approves edits, types in the composer, opens and closes the right panel, and scrolls.
5. Writes `report.md`, `summary.json`, `profile.cpuprofile` (open in Chrome DevTools), screenshots, and `server.log` to `.t3/stress/runs/<time>` or `--out`.

Threads run supervised, so each stops at its edit approval until the rig visits it, and the sidebar always holds a mix of streaming, waiting, and settled threads.

## Huge pull requests

`--pr owner/name#123` links a recorded pull request to the first thread and keeps its panel open beside the stream: the rig expands diffs and scrolls the code tab, and switches to the timeline now and then, while it visits the other threads to approve.

Record a pull request once per machine with `vp run stress:record-pr owner/name#123` (needs `gh` signed in). It fetches the base and head commits into a bare clone and opens the pull request on a recording server, which saves every read the panel makes, from the pull request page and from a thread's panel. Recordings live in `~/.cache/t3code-stress/fixtures` and are shared by every checkout.

During a run the server serves GitHub pull request reads from those files (`T3CODE_PR_FIXTURES`, see `apps/server/src/pullRequest/PullRequestFixtures.ts`): recorded reads as GitHub answered them, and diffs from the clone, since GitHub's API truncates diffs this size. Nothing reaches GitHub, so runs are repeatable and offline. Reads the recording missed fail as not found; record again after the panel starts reading something new.

Reference pull requests: `pingdotgg/t3code#2829` (about 585k changed lines, 932 review threads), `oven-sh/bun#30412` (about 1M lines), and `oven-sh/bun#45631` (about 2.3M lines in 19k files).

## Reading the report

- **Frames over 33 ms** and **long animation frames** are what a user feels. The long-frame scripts table says what ran during them: `dispatchDiscreteEvent` is a click or key handler, `onMessage` is server traffic.
- **CPU self time by module** splits the profile by package and source file. **By function** points at the hot code. Samples with no page script on the stack (the rig's own Playwright work, browser internals) are counted apart.
- **Most rendered components** counts React renders over the window. A component that renders far more often than what it shows changes is the usual lead.
- **JS heap** and **DOM nodes** are sampled each step; a climb across the run is a leak or unbounded list.
- **Health** must stay at zero error boundaries and page errors; console 404s for missing favicons are expected offline.

## Daily use

Run it on `main`, compare `summary.json` with the previous run, and investigate the largest regression or the largest remaining cost: open the profile, confirm the cause in code, fix it, and show the before and after runs in the PR. Numbers are machine-dependent; compare runs from the same machine.
