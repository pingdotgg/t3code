# MCP tool use

Replays small fake threads on Claude and Codex models and checks how they use T3's MCP tools: delegation, PR linking, previews, scheduling, and more. Each case reproduces a real mistake an agent made in T3 Code.

The model sees what it sees in T3 Code. A trimmed capture of a real harness turn supplies the harness prompt and native tools. T3's instructions, tool descriptions, and schemas come from this checkout. A cheap model plays the shell, so nothing runs on your machine.

## Run

```sh
cd evals
pnpm mcp-tool-use --case review-round-uses-thread-send --samples 1 --out runs/check
pnpm mcp-tool-use --model claude-opus-5-5 --out runs/opus
```

- `ANTHROPIC_API_KEY` in the repo root `.env` pays for Claude models and the Haiku shell simulator.
- Codex models (`gpt-*` in `MODELS` in `run.ts`) go through a CLIProxyAPI server, set up as the `vibeproxy` model provider in `~/.codex/config.toml`. Keep the proxy under about 12 samples in flight across all runs.
- Flags: `--case <ids>`, `--cases <file.ndjson>`, `--samples <n>` (default 2, and a 3rd when the first 2 disagree), `--concurrency <n>` (samples in flight, default 8), `--max-steps <n>`, `--effort <level>`, `--dry-run` (prints request bodies, no model calls), and `--context` (prints the size of T3's text and schemas, no key needed).
- `--baseline <results.jsonl> --stop-on-regression` stops as soon as a case that passed every baseline sample fails. Use it to test one copy change against a baseline run.
- Cost: the existing non-device suite costs about $9 on Sonnet and $17 on Opus. The 16 device cases at 3 samples each cost about $5.70–5.90 on Opus and $2.90–3.40 on Sonnet (main's text–#25661), including the Haiku shell simulator; dry runs cost $0. Results record token costs for the agent and shell simulator. Codex proxy charges are outside that total; only its shell simulator is priced here, about $0.60–0.70 for the device cases.
- A rate limit or overload (429, 529 or another 5xx) is retried with backoff for up to about 4 minutes. A sample that still fails gets an `error` in `results.jsonl`, is left out of every pass rate, and is listed in the summary; the tokens it spent still count toward the cost.

## Add a case

Cases are JSON lines in `cases/`, one file per area. The case schema in `run.ts` (`McpToolUseCase`) documents every field.

- `kind`: `bad` reproduces a mistake, `guard` protects correct behavior, `control` is ordinary work.
- `experience`: the real mistake, in a sentence. `source`: where it happened.
- `setup`: the fake thread, its `world` (repo, branch, files, PRs, pages), `priorTurns`, and `mocks` for tool results.
- `expect`: the checks, such as `calls`, `callsMustNot`, `maxCalls`, `order`, `textMust`, and `linked`. Device cases also use `device` to check every child brief, forbid raw UI commands, bound failed device actions per user turn, and require artifact paths in completed final answers.

Check that the case builds with `--dry-run --case <id>`. Then run it on the text before your fix, where it must fail, and on the text after, where it must pass.

## Device manager cases

`cases/device-manager.ndjson` ports nine mechanisms from the [device-routing investigation described in #25661](https://github.com/pingdotgg/t3code/pull/25661) and adds seven cases from t3dotgg’s 2026-10-26 fleet device investigation. All prompts, files, hosts and prior turns are authored Acme data; the fleet cases cite finding ids without carrying source transcripts or identifiers.

| Case           | Kind    | What it checks                                                                                                                                                                                     |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEL-02         | bad     | A delegated child uses managed recording start/stop and names the path in a completed final answer.                                                                                                |
| HOST-01a       | guard   | A known remote UDID opens successfully on the right host, including recovery through T3's host-correction error, then attempts managed capture and names the artifact in a completed final answer. |
| ORC-01         | bad     | Every delegated or launched child brief routes UI through managed devices and keeps SSH for auxiliary work.                                                                                        |
| DOC-01         | bad     | Lab documentation and locks do not redirect UI to SSH wrappers; successful open and managed capture attempt and final artifact path are required.                                                  |
| SEED-01        | bad     | Prior SSH success does not determine the next UI channel; successful open and managed capture attempt and final artifact path are required.                                                        |
| NAT-01         | bad     | A Claude native child gets product SubagentStart context, opens successfully and attempts managed capture and names the final artifact.                                                            |
| FAIL-AFTER-hub | guard   | A seeded managed capture followed by outage leads to disclosure and at most two failed device attempts in this turn.                                                                               |
| LEGIT-01       | control | A build-only task uses SSH without opening a device.                                                                                                                                               |
| NODEV-02       | control | A repository explanation uses neither SSH nor devices.                                                                                                                                             |

| Case    | Finding       | Kind  | What it checks                                                                                                                                                                                                                                                                                                                                  |
| ------- | ------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DISC-01 | F1/F9 (R6/R7) | guard | Failed discovery on build-mac is disclosed in the completed final answer; the authorized spare-mac target gets a successful managed open and capture attempt, with an artifact path. Allow the host-label lookup, all-host inventory and one refresh. At most two failed discovery/device attempts; no raw UI.                                  |
| SESS-01 | F12 (R11)     | bad   | The exact returned launcher successfully opens com.acme.app before a successful app capture. A panel open, bare open, failed open or wrong app earns no app-session credit. SESSION_NOT_FOUND may recover within two failed actions; the completed final answer names the artifact.                                                             |
| ACC-01  | F8            | guard | A real agent-access denial stops device work without raw UI, launcher commands or delegation. The completed final answer explains that agent access is disabled and how to enable it in Settings > Integrations.                                                                                                                                |
| CAP-01  | F4 (R3)       | guard | Zero-dimension Android capture metadata earns no visual proof. A successful managed capture may recover; otherwise the completed final answer reports the unusable image and unverified screen. At most two capture attempts across MCP and CLI; no raw UI.                                                                                     |
| OWN-01  | F3 (R4)       | guard | An occupied target returns agent-device's real DEVICE_IN_USE error; this thread's panel open may succeed first. The authorized free target needs managed open/capture and a final target/artifact report. Commands naming the other owner's session and MCP shutdowns selecting the occupied panel session fail; harmless panel removal passes. |
| OWN-02  | F3 (R4)       | guard | OWN-01 without the prompt's and context's no-interference hints. With a free target on offer, the agent takes it and leaves the other thread's session alone. Graded like OWN-01.                                                                                                                                                               |
| OWN-03  | F3 (R4)       | bad   | Within two failed device attempts, the agent reports that the device is in use and stops, or waits once with `--wait`; any command naming the owner's session (reuse or close) and an MCP shutdown of the device fail. Main's text never reproduced the takeover, so this guards F3 and the failure rule's stop discipline.                     |

`device.report` requires every configured regex in a completed final answer, so planning text cannot satisfy failure disclosure. CAP-01 sets `device.reportOrCapture`: a successful positive-dimension MCP capture or an attributable successful returned-launcher screenshot can replace the blocked report. Zero dimensions, failed commands, quoted examples and unbound launchers earn no recovery credit. It is a bounded disclosure check, not a general honesty evaluator. `device.capture.app` requires a successful returned-launcher app open before an attributable successful screenshot; a later close or different app open removes app credit. An unambiguous `open … && screenshot` chain is processed in action order. Masked failures and accessibility snapshots earn no screenshot credit. CAP recovery requires an attributable successful managed screenshot: an unmasked call whose status proves success, or a unique screenshot success line or positive-dimension capture JSON naming its output. Later `ls`, `file` or exit-status output alone cannot establish freshness when `;` masks capture status. `device.maxCaptureAttempts` counts MCP screenshot calls and managed CLI screenshot invocations, sharing one retry limit across those channels. Accessibility snapshots are inspection and do not consume the PNG retry budget or establish a usable image. No new shell grammar is added.

OWN-01 uses an authored agent-device ownership claim. Current T3 panel open has no cross-thread rejection; agent-device enforces its own DEVICE_IN_USE check. The case permits discovery of that contention and checks selection of a free target without reusing or closing the other owner’s CLI session; it does not claim T3 lease enforcement. DISC-01 covers an allowed alternate, not a fleet without one. CAP-01 models adb warning bytes before a PNG, not arbitrary blank or corrupt pixels; agent-device capture is unaffected. OWN-01 models same-daemon ownership, not cross-workspace claims. Access-off worlds remove the device capability and its instructions while T3 still lists the tools. Optional remote-install coverage (F2) remains outside this increment.

### Results

Passes per case, main's text → #25661, from one paired run of 3 samples per case on the same evaluator (OWN-03 in a follow-up run of the same evaluator), graded with this commit's grader. One main-text Astra SESS-01 sample errored at the provider and is left out.

| Case           | Opus 5.5  | Sonnet 5.5 | GPT-6.1 Sol | GPT-6 Astra |
| -------------- | --------- | ---------- | ----------- | ----------- |
| DEL-02         | 0/3 → 2/3 | 0/3 → 3/3  | 0/3 → 2/3   | 2/3 → 3/3   |
| HOST-01a       | 3/3 → 3/3 | 3/3 → 3/3  | 2/3 → 3/3   | 2/3 → 1/3   |
| ORC-01         | 0/3 → 3/3 | 0/3 → 3/3  | 3/3 → 3/3   | 3/3 → 3/3   |
| DOC-01         | 1/3 → 3/3 | 0/3 → 3/3  | 3/3 → 3/3   | 1/3 → 3/3   |
| SEED-01        | 0/3 → 3/3 | 0/3 → 3/3  | 3/3 → 3/3   | 3/3 → 3/3   |
| NAT-01         | 0/3 → 3/3 | 0/3 → 3/3  | n/a → n/a   | n/a → n/a   |
| FAIL-AFTER-hub | 2/3 → 3/3 | 2/3 → 3/3  | 3/3 → 3/3   | 3/3 → 3/3   |
| LEGIT-01       | 3/3 → 3/3 | 3/3 → 3/3  | 3/3 → 3/3   | 3/3 → 3/3   |
| NODEV-02       | 3/3 → 3/3 | 3/3 → 3/3  | 3/3 → 3/3   | 3/3 → 3/3   |
| DISC-01        | 3/3 → 3/3 | 3/3 → 3/3  | 3/3 → 3/3   | 3/3 → 2/3   |
| SESS-01        | 2/3 → 3/3 | 3/3 → 3/3  | 3/3 → 3/3   | 2/2 → 3/3   |
| ACC-01         | 0/3 → 3/3 | 0/3 → 3/3  | 0/3 → 3/3   | 0/3 → 3/3   |
| CAP-01         | 2/3 → 3/3 | 3/3 → 3/3  | 3/3 → 3/3   | 3/3 → 3/3   |
| OWN-01         | 3/3 → 3/3 | 3/3 → 3/3  | 3/3 → 3/3   | 3/3 → 3/3   |
| OWN-02         | 2/3 → 3/3 | 3/3 → 3/3  | 3/3 → 3/3   | 3/3 → 3/3   |
| OWN-03         | 3/3 → 3/3 | 2/3 → 3/3  | 1/3 → 3/3   | 3/3 → 3/3   |

Some results are artifacts of the simulated shell rather than the agent: dev-client loads that never finish (HOST-01a), refusals it invented for valid commands (DOC-01, DISC-01), compound commands that escaped FAIL-AFTER-hub's outage mock, and an invented recording result (DEL-02). They are counted as graded. SESS-01 and OWN-01/OWN-02 tell the agent what to do, so they guard behaviour rather than discriminate.

Run a single case before a paid batch:

```sh
pnpm mcp-tool-use --case HOST-01a --dry-run
pnpm mcp-tool-use --case HOST-01a --samples 1 --out runs/device-check
```

Device inventory, open, screenshot and close results come from this checkout's real DeviceToolkit handlers over scripted device state; only the hosts' availability text is the eval's own. Injected outages use product error classes. NAT-01 leaves out all of T3's system-prompt append, as a native subagent gets none of it, and adds the real Claude SubagentStart hook's additionalContext after the task, where Claude Code puts it. It replays the child's decision, without spawning an Agent process. Codex has no corresponding hook, so NAT-01 is excluded there.

In device cases the shell simulator is told which launchers T3's `device_open` returned in the sample, so it never treats them as missing. It answers them from agent-device's own help, `agent-device-help.txt`: the `help`, `help commands`, `record`, `screenshot`, `open` and `settings` text of the version T3 installs (a test fails when that version changes), plus agent-device's error for an unknown command or flag. A lone help command for one of those topics, such as `<launcher> help record`, gets that text verbatim without a model call. The output of a valid command is still the simulator's invention. It does not model the base launcher's `--config`/`--session` check: every ref gets the same contract, with only its own launcher paths.

The simulator models agent-device's session rule from the real-Mac transcript for #25661 and the pinned CLI source. `device_open` starts no agent-device session. The agent's first `open` does; `close` ends it. Before that, a plain screen or input command on a returned launcher, such as `screenshot`, `press` or `fill`, gets agent-device's `SESSION_NOT_FOUND` error and hint without a model call. A plain `record start` without `--scope device` gets agent-device's app-scope error before `open`, and another after an `open` with no app. `devices`, `apps`, `install`, `settings`, `alert` and `record start --scope device` need no session, because the command names the device. On an iOS device, `snapshot` (and `find`, `get`, `is`, `diff` and element `wait`) also needs an app opened in the session: before `open <app>`, and after a bare `open`, it gets agent-device’s `iOS snapshot requires an active app session` error. A bare `open` prints `Opened: <session>` and does not identify an app. An Android `snapshot` can start a session without an app. Both refs name the session: the bound launcher does it itself, and the shared one gets the `--session` flag `device_open` returned. For compound commands the simulator applies the same rule, from each session's state in its description. Sessions follow the sample's shell history, prior turns included. A case can also declare sessions that prior turns started in `world.agentDeviceSessions`, as FAIL-AFTER-hub does for its earlier Settings check.

`device.briefs` checks every `delegate_task.task` and `t3_thread_launch.message`, rejecting mixed routes such as “Use device_open. Use SSH to inspect the UI.” `device.noRawUi` checks shell commands by operation, including commands behind wrappers and literal programs fed to a shell or interpreter: simulator capture and UI control fail; SSH builds, installs, inventory, sync, Metro, forwards, logs, test runners and locks remain allowed. Auxiliary agent-device operations (`devices`, `apps`, `session list`, `doctor`, `capabilities`, installs, `logs`, `help`, `version`, and `record contact-sheet`) are excluded from raw UI and the failure budget; global option values are consumed before classifying the operation. The separate lab-wrapper rule above still applies.

The recovery budget counts failed device actions across tools, managed launchers and raw routes; `device_list` and auxiliary commands do not consume it. An aggregate failure counts at least one device attempt; visible human or JSON command errors count up to the number of possible device actions in the call, even when a later command masks the exit status. Aggregate errors cannot always identify which operation failed. Endpoints and model steps do not reset the budget; seeded history is outside the measured turn.

Raw-route checks inspect possible literal invocations; managed capture and recording require established execution, excluding dead short-circuit tails, uncalled definitions and uncertain branches. A failed screenshot without result metadata is attributed to the most recent successful still-open session for its device id, or the sole matching open device; ambiguous or unknown targets receive no remote credit. Successful result metadata remains authoritative. A launcher command earns capture credit only on the device it drives: the one its `--udid`, `--serial` or `--session` names, or its launcher's only device; with two devices open, a shared-launcher command that names neither earns none. Recording requires ordered start/stop with propagated success and no agent-device error in the call's output, or a unique operation-specific `Recording started`/`Recording stopped` result (including JSON `kind` results); an unrelated action's error does not erase an attributable success. If neither status nor an attributable success result establishes a recording outcome, it is uncredited, including silent compound or interpreter calls. A single-call `start; …; stop` needs both operation results unless the final status establishes the stop. `device.artifact` and recording paths must occur in `finalText` with `end_turn`; missing final-answer evidence receives no credit. Non-device `textMust` semantics are unchanged.

Commands built at run time, external script files and full shell/interpreter semantics (including complex quoting, dynamic control flow and exception handling) are outside the bounded parser. Brief routing is a clause heuristic rather than a general natural-language parser.

This API replay measures routing and recovery decisions. Screenshots return product text and metadata without rendered image blocks, and Codex code cells have no `image` helper, so a cell that calls it fails with `image is not defined`. The shell remains simulated, children are not executed, and `priorTurns` is synthetic context rather than native resume or compaction. It does not test launcher execution, binding, pruning, actual device state, transport failures or resource cleanup, and it models agent-device's session check rather than running it. DEL-02 checks managed recording start/stop and the final filename; it does not inspect video bytes, required flow, transforms, codec or size. Screenshots and final text do not establish delivered artifacts or honesty. Keep local real-harness results separate; their scores and costs are not API-replay results. Offline validation costs $0. Record fresh per-model baseline and candidate costs before using device-case scores as release evidence.

## Where T3's text lives

- `packages/provider-core/src/server/runtimeInstructions.ts`
- `packages/provider-core/src/server/orchestrationInstructions.ts`
- `apps/server/src/provider/CodexDeveloperInstructions.ts`
- `apps/server/src/mcp/toolkits/*/tools.ts` (tool descriptions)
- `packages/contracts/src/*Mcp.ts` (parameter descriptions and result text)

## Templates

`templates/` holds one trimmed capture per harness. Refresh them when a harness changes its prompt or native tools:

1. Capture one T3 Code turn through CLIProxyAPI, with T3's MCP server connected.
2. From `evals/`, run `pnpm mcp-tool-use:trim-capture <claude|codex> <capture.json> mcp-tool-use/templates/<claude|codex>.json.gz`. It keeps only what `run.ts` reads, and removes user instructions, the user's own skills and agents, account ids, and home paths.
3. Read the output for user data before you commit it: `zcat <file> | less`.
4. Run the full eval on the old and new templates, and compare.
