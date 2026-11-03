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
- `--shell-model` picks the model that plays the shell: `claude-haiku-5-5` by default, or `gpt-6.1-terra` / `gpt-6-luna` through the same proxy, so Codex runs need no Anthropic key. Prefer Terra: Luna often contradicts the case's world (it calls named checkouts missing or files empty). Compare runs only when they used the same shell model.
- Flags: `--case <ids>`, `--cases <file.ndjson>`, `--samples <n>` (default 2, and a 3rd when the first 2 disagree), `--concurrency <n>` (samples in flight, default 8), `--max-steps <n>`, `--effort <level>`, `--dry-run` (prints request bodies, no model calls), and `--context` (prints the size of T3's text and schemas, no key needed).
- `--baseline <results.jsonl> --stop-on-regression` stops as soon as a case that passed every baseline sample fails. Use it to test one copy change against a baseline run.
- Cost: the existing non-device suite costs about $9 on Sonnet and $17 on Opus. The 16 device cases at 3 samples each cost about $5.70–5.90 on Opus and $2.90–3.40 on Sonnet (main's text–#25661), including the Haiku shell simulator; dry runs cost $0. Results record token costs for the agent and shell simulator. Codex proxy charges are outside that total; only its shell simulator is priced here, about $0.60–0.70 for the device cases.
- A rate limit or overload (429, 529 or another 5xx) is retried with backoff for up to about 4 minutes. A sample that still fails gets an `error` in `results.jsonl`, is left out of every pass rate, and is listed in the summary; the tokens it spent still count toward the cost.

## Add a case

Cases are JSON lines in `cases/`, one file per area. The case schema in `run.ts` (`McpToolUseCase`) documents every field.

- `kind`: `bad` reproduces a mistake, `guard` protects correct behavior, `control` is ordinary work.
- `experience`: the real mistake, in a sentence. `source`: where it happened.
- `setup`: the fake thread, its `world` (repo, branch, files, PRs, pages), `priorTurns`, and `mocks` for tool results.
- `expect`: the checks, such as `calls`, `callsMustNot`, `maxCalls`, `order`, `shellMust`, `textMust`, `finalTextMust` (the last text, once the turn ended), and `linked`. A call's `args` match partially: `~text` is a case-insensitive substring, `"<=N"` / `">=N"` bound a number, `null` matches a missing key, and keys may be dotted paths. Device cases also use `device` to check every child brief, forbid raw UI commands, bound failed device actions per user turn, and require artifact paths in completed final answers. Secrets cases use `secret` (see [Secrets cases](#secrets-cases)).

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

Passes per case, main's text → the request_secret guidance change stacked on this PR. The shell is `gpt-6.1-terra`. n=6 per cell, except Sonnet guards and controls (n=3). Opus 5.5 was not run. The base arm is main's samples, regraded with the final graders. The candidate arm is a full run on an earlier head of the change, plus reruns on the final head for the cells its later edits touch (pasted PIN, transcript recovery, pasted password).

| Case                         | Sonnet 5.5                  | GPT-6.1 Sol         | GPT-6 Astra                           |
| ---------------------------- | --------------------------- | ------------------- | ------------------------------------- |
| adb-pairing-code             | 0/6 → 6/6                   | 6/6 → 6/6           | 6/6 → 6/6                             |
| cli-deploy-token             | 0/6 → 6/6                   | 5/6 → 6/6           | 6/6 → 6/6                             |
| staging-login-after-denial   | 0/6 → 4/6                   | 5/6 → 6/6           | 5/6 → 6/6                             |
| pasted-pin-delegation        | 0/6 → 6/6 (final head: 2/3) | 2/6 → 6/6           | 3/6 → 6/6                             |
| transcript-recovery          | 2/3 → 3/3                   | 6/6 → 6/6           | 6/6 → 6/6                             |
| child-signin-wall            | 0/3 (not admitted)          | 0/6 → 0/6           | 0/6 → 0/6                             |
| live-check-skipped           | 0/6 → 0/6                   | 5/6 → 6/6           | 6/6 → 6/6                             |
| adb-pairing-declined (guard) | 0/3 → 2/3                   | 6/6 → 6/6           | 6/6 → 6/6                             |
| live-check-declined (guard)  | 0/3 → 2/3                   | 6/6 → 6/6           | 6/6 → 6/6                             |
| ctrl-sudo                    | 3/3 → 3/3                   | 5/6 → 6/6           | 0/6 → 6/6                             |
| ctrl-oauth                   | 3/3 → 3/3                   | 4/6 → 4/6           | 4/6 → 6/6                             |
| other guards and controls    | all pass → all pass         | all pass → all pass | all pass → all pass (prod-config 5/6) |

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
