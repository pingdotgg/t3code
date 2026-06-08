# swarm/BEACON.md — Agent BEACON append-only log

Domain: Claude Remote Control launch (`t3 remote-control` / `rc` CLI + launcher module).
Follows the 2026 Multi-Agent Standard. This is BEACON's append-only record; never edited by other agents.

---
FROM: BEACON
TO: ALL
PHASE: AUDIT
CONFIDENCE: HIGH
REFS: apps/server/src/provider/Drivers/ClaudeHome.ts:17 (makeClaudeEnvironment),
      apps/server/src/provider/ProviderInstanceEnvironment.ts:3 (mergeProviderInstanceEnvironment),
      apps/server/src/provider/providerMaintenanceRunner.ts:70 (spawn pattern via ChildProcessSpawner),
      apps/server/src/process/externalLauncher.ts:300 (launchAndUnref spawn pattern + test style),
      apps/server/src/provider/providerMaintenance.ts:198 (normalizeCommandPath),
      apps/server/src/provider/Errors.ts (Schema.TaggedErrorClass style),
      packages/contracts/src/settings.ts:205 (ClaudeSettings: binaryPath/homePath/launchArgs),
      apps/server/src/cli/auth.ts, apps/server/src/cli/project.ts, apps/server/src/cli/server.ts (Command structure),
      apps/server/src/bin.ts:41 (makeCli withSubcommands — owned by HELM, C4),
      apps/server/src/terminal/Services/Manager.ts (TerminalManager interface only),
      packages/shared/src/cliArgs.ts:31 (parseCliArgs),
      .repos/effect-smol/.../ChildProcess.ts:405 (CommandOptions: cwd/env/extendEnv/stdin/stdout/stderr "inherit")
---

Grounding complete. Key findings verified against source:

1. **HOME/account resolution is already centralized.** `makeClaudeEnvironment(config: Pick<ClaudeSettings,"homePath">, baseEnv)`
   returns `baseEnv` unchanged when `homePath` is empty, else `{ ...baseEnv, HOME: resolvedHomePath }`
   (resolved via `expandHomePath` + `path.resolve`, requires `Path.Path`). I will REUSE this verbatim — no
   reimplementation of HOME logic (per IMPLEMENT.1).

2. **`ClaudeSettings` shape** (contracts/src/settings.ts): `enabled`, `binaryPath` (default `"claude"`),
   `homePath` (default `""`), `customModels`, `launchArgs` (default `""`). The launcher input only needs
   `binaryPath` + `homePath` (+ optional `launchArgs`); I'll type the input as a `Pick`-style structural
   subset so a full `ClaudeSettings` satisfies it.

3. **Canonical spawn mechanism = `ChildProcessSpawner` + `ChildProcess.make(command, args, options)`.**
   `providerMaintenanceRunner.ts` spawns `claude update` this exact way; `externalLauncher.ts` shows the
   `spawner.spawn(ChildProcess.make(...))` + `Effect.scoped` + `mapError` pattern and the canonical TEST
   style (`Layer.mock(ChildProcessSpawner.ChildProcessSpawner, { spawn })` capturing `spawnedCommand`,
   asserting `.command` / `.args` / `.options`). `CommandOptions` supports `stdin/stdout/stderr: "inherit"`,
   `cwd`, `env` + `extendEnv`. Handle exposes `.exitCode: Effect<ExitCode, PlatformError>` and `.kill()`.
   For RC we want **inherited stdio** so pairing/registration output is visible (IMPLEMENT.1).

4. **CLI command structure** (auth.ts / project.ts / server.ts): `Command.make(name, flags).pipe(`
   `Command.withDescription, Command.withHandler)`. Flags via `Flag.string/boolean/choice` + `Flag.optional`
   / `Flag.withDefault` / `Flag.withAlias`; positional via `Argument.string(...).pipe(Argument.optional)`.
   Handlers `yield* GlobalFlag.LogLevel` and run an Effect. The root `t3` command (bin.ts `makeCli`) provides
   `CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer)` — `NodeServices.layer` supplies
   **both `ChildProcessSpawner` and `Path.Path`** to every subcommand handler. So my handler can `yield*`
   the spawner/path directly; no extra layer wiring needed (and I must NOT touch bin.ts — C4).

5. **Error class style** = `Schema.TaggedErrorClass<T>()("Name", { fields })` with `override get message()`.
   provider/Errors.ts is the template. I'll mirror it in a new `remoteControl/Errors.ts`.

6. **`parseCliArgs`** (shared/cliArgs.ts) is what ClaudeAdapter uses to split `launchArgs`. For RC passthrough
   I will accept already-tokenized passthrough args from the CLI and NOT re-parse the official RC flags; the
   `--name <title>` is handled explicitly per spec.

7. **In-app terminal launch path is NOT fully wireable this session.** `apps/server/src/terminal/` contains
   ONLY `Services/Manager.ts` (the `TerminalManagerShape` *interface* + `PTY.ts` import) in this clone — there
   is NO `terminal/Layers/NodePTY.ts` and no concrete live layer present (grep/glob confirm). The prompt's
   grounding read for NodePTY does not exist here. Per IMPLEMENT.3, wiring it fully is therefore RISKY without
   a typecheck, so I will provide the standalone launcher (`buildRemoteControlInteractiveCommandLine`) usable
   by a future terminal host, and write a precise SPEC into this log for ATLAS/HEAD_DEV rather than editing the
   nonexistent layer.

8. **Remote Control argv (official, per HEAD_DEV AUDIT + docs):** server/background mode →
   `claude remote-control [...]`; interactive → `claude --remote-control [...]` (`--rc` alias). `--name <title>`
   names the session. Needs claude.ai OAuth (Pro/Max/Team/Enterprise), NOT an API key — I'll print a one-line
   note. T3 only LAUNCHES the real `claude`; Anthropic provides the relay (no relay built here).

No conflicts with HELM/ATLAS file domains (my files are all-new under `remoteControl/` + `cli/remoteControl.ts`).

OUTPUTS_DECLARED: (none this phase — AUDIT is read-only)
BLOCKING_ON: NONE
REVERSIBLE: YES

---
FROM: BEACON
TO: HEAD_DEV
PHASE: DESIGN
CONFIDENCE: HIGH
REFS: apps/server/src/remoteControl/* (new), apps/server/src/cli/remoteControl.ts (new)
---

Plan (all-new files; no edits to existing modules; bin.ts untouched per C4):

A. `apps/server/src/remoteControl/Errors.ts`
   - `ClaudeRemoteControlLaunchError` (Schema.TaggedErrorClass) — binary spawn/exit failure.
     Fields: `binaryPath: string`, `mode: string`, `detail: string`, `cause?: Defect`. `override get message()`.
   - `ClaudeRemoteControlExitError` — non-zero exit of the `claude` RC process.
     Fields: `binaryPath`, `mode`, `exitCode: number`, `cause?`. `override get message()`.
   - Union type `ClaudeRemoteControlError`.

B. `apps/server/src/remoteControl/ClaudeRemoteControlLauncher.ts`
   - `RemoteControlMode = "server" | "interactive"`.
   - Input type `ClaudeRemoteControlSettings = Pick<ClaudeSettings, "binaryPath" | "homePath">` (structural; a
     full ClaudeSettings satisfies it).
   - `buildRemoteControlArgs({ mode, name?, passthrough })`: pure → server: `["remote-control", ...pass]`;
     interactive: `["--remote-control", ...pass]`; when `name` set, append `["--name", name]` (placed before
     passthrough). Exported for unit test (no spawn).
   - `resolveRemoteControlLaunch(settings, { mode, name?, passthrough?, cwd?, baseEnv? })` (Effect, needs
     `Path.Path`): returns `{ command, args, options }` where `command = settings.binaryPath`,
     `args = buildRemoteControlArgs(...)`, and `options` = `{ env: yield* makeClaudeEnvironment(settings, baseEnv),
     extendEnv: true, cwd?, stdin/stdout/stderr: "inherit" }`. REUSES `makeClaudeEnvironment` (no HOME reimpl).
     Exported for unit test (asserts binary + HOME env + mode flag) — pure resolution, still no spawn.
   - `launchClaudeRemoteControl(settings, opts)` (Effect, needs `ChildProcessSpawner` + `Path.Path`): builds via
     `resolveRemoteControlLaunch`, `spawner.spawn(ChildProcess.make(command, args, options))` inside
     `Effect.scoped`, awaits `handle.exitCode`; maps spawn failure → `ClaudeRemoteControlLaunchError`, non-zero
     exit → `ClaudeRemoteControlExitError`. Returns the exit code on success (0).
   - `buildRemoteControlInteractiveCommandLine(settings, opts)`: returns `{ command, args }` for a terminal host
     (in-app path, mode forced `interactive`) — no spawn, no stdio. Used by the SPEC below.

C. `apps/server/src/remoteControl/ClaudeRemoteControlLauncher.test.ts`
   - Pure tests for `buildRemoteControlArgs` (server vs interactive vs `--name`).
   - `resolveRemoteControlLaunch` under `NodeServices.layer`: asserts `command === binaryPath`,
     `args` mode flag + passthrough, and `options.env.HOME === resolved homePath` (and that empty homePath
     leaves HOME from baseEnv). Asserts stdio inherit + extendEnv. NO actual `claude` spawn.
   - One spawn-path test using `Layer.mock(ChildProcessSpawner.ChildProcessSpawner, { spawn })` capturing the
     `StandardCommand` (mirrors externalLauncher.test.ts) and a mock handle returning exit code 0 — asserts the
     command passed to the spawner, never executes a real binary.

D. `apps/server/src/cli/remoteControl.ts`
   - `remoteControlCommand = Command.make("remote-control", { claudeHome, name, interactive, server, cwd })`
     `.pipe(Command.withDescription, Command.withAlias("rc"), Command.withHandler(...))`.
   - Flags: `--claude-home <path>` (→ ClaudeSettings.homePath), `--name <title>` (optional),
     `--interactive` / `--server` (booleans, default server; mutually exclusive → if both set, fail with a
     CliError.UserError-style message). Positional optional `cwd`.
   - Handler: resolve mode, print the one-line OAuth note (`Console.log`), build a
     `{ binaryPath: "claude", homePath }` settings object (binaryPath stays default `claude`; resolving a
     per-instance binaryPath from persisted settings is out of scope this sprint — note for follow-up), then
     `yield* launchClaudeRemoteControl(settings, { mode, name?, cwd? })`.
   - `export const remoteControlCommand`.

E. In-app launch helper (IMPLEMENT.3): provide `buildRemoteControlInteractiveCommandLine` (in B) as the
   standalone, typecheck-safe surface. Full terminal wiring is SPECced below (no concrete terminal Layer exists
   in this clone → editing it would be LOW-confidence and unverifiable).

CONFIDENCE notes (assumptions flagged):
 - MEDIUM: exact Flag/Command combinators (`Command.withAlias`, `Flag.boolean(...).pipe(Flag.withDefault(false))`)
   match auth.ts/server.ts usage; if `Command.withAlias` is not the exact export name, HEAD_DEV/HELM can adjust
   the single alias line at registration. Everything else is HIGH (verified).
 - The CLI handler relies on `NodeServices.layer` (provided in bin.ts CliRuntimeLayer) for ChildProcessSpawner +
   Path — verified present; no new layer needed.

OUTPUTS_DECLARED:
 - apps/server/src/remoteControl/Errors.ts (new)
 - apps/server/src/remoteControl/ClaudeRemoteControlLauncher.ts (new)
 - apps/server/src/remoteControl/ClaudeRemoteControlLauncher.test.ts (new)
 - apps/server/src/cli/remoteControl.ts (new)
 - swarm/BEACON.md (this log)
BLOCKING_ON: NONE (HELM owns bin.ts registration; I only export the command — no cross-dependency for IMPLEMENT)
REVERSIBLE: YES (all additive; delete the new files + the one import/registration line HELM adds)

---
FROM: BEACON
TO: ALL
PHASE: IMPLEMENT
CONFIDENCE: HIGH
REFS: apps/server/src/remoteControl/Errors.ts (new),
      apps/server/src/remoteControl/ClaudeRemoteControlLauncher.ts (new),
      apps/server/src/remoteControl/ClaudeRemoteControlLauncher.test.ts (new),
      apps/server/src/cli/remoteControl.ts (new)
---

Implemented exactly as DESIGNed. All additive; no existing files edited; bin.ts untouched (C4).

1. `remoteControl/Errors.ts` — `ClaudeRemoteControlLaunchError` (spawn/exit-read failure),
   `ClaudeRemoteControlExitError` (non-zero exit), `ClaudeRemoteControlError` union. `Schema.TaggedErrorClass`
   + `override get message()`, mirroring provider/Errors.ts.

2. `remoteControl/ClaudeRemoteControlLauncher.ts`:
   - `buildRemoteControlArgs` (pure): server -> `["remote-control", ...]`, interactive -> `["--remote-control", ...]`,
     `--name <title>` inserted before passthrough (trimmed; blank name ignored).
   - `resolveRemoteControlLaunch` (Effect, needs Path.Path): REUSES `makeClaudeEnvironment(settings, baseEnv)`
     for HOME — no HOME reimpl. Returns `{ command: binaryPath, args, options }` with `extendEnv: true` and
     `stdin/stdout/stderr: "inherit"`; `cwd` added only when provided.
   - `launchClaudeRemoteControl` (Effect, needs ChildProcessSpawner + Path.Path): spawns via
     `spawner.spawn(ChildProcess.make(command, [...args], options))` inside `Effect.scoped`, awaits
     `child.exitCode`, maps spawn/read failure -> LaunchError and non-zero exit -> ExitError; returns 0 on success.
     Same spawn mechanism as providerMaintenanceRunner / externalLauncher.
   - `buildRemoteControlInteractiveCommandLine` (pure): `{ command, args }` with mode forced `interactive`,
     for the in-app terminal host (see SPEC below). No spawn/stdio.
   - Types `ClaudeRemoteControlSettings = Pick<ClaudeSettings,"binaryPath"|"homePath">`, `RemoteControlMode`,
     `DEFAULT_REMOTE_CONTROL_MODE = "server"`, and the error union re-export.

3. `remoteControl/ClaudeRemoteControlLauncher.test.ts` — pure-arg tests (server/interactive/--name/blank-name),
   `resolveRemoteControlLaunch` under NodeServices.layer (asserts binary, mode flag, inherited stdio,
   `extendEnv`, empty-homePath leaves env untouched, non-empty homePath sets resolved `HOME`, `cwd` honored),
   and a spawn-path test using `Layer.mock(ChildProcessSpawner.ChildProcessSpawner, { spawn })` with a mock
   handle (exit 0 asserts the StandardCommand; exit 2 asserts Failure). NEVER spawns a real `claude`.

4. `cli/remoteControl.ts` — `remoteControlCommand` = `Command.make("remote-control", {...}).pipe(`
   `Command.withDescription, Command.withAlias("rc"), Command.withHandler)`. Flags: `--claude-home` (Option,
   -> homePath), `--name` (Option), `--interactive`/`--server` (boolean, default false; both set -> fail with a
   `CliError.UserError` subclass `RemoteControlModeConflictError`; neither -> default `server`). Optional `cwd`
   positional. Handler prints the OAuth one-liner via Console.log, builds `{ binaryPath:"claude", homePath }`,
   and calls `launchClaudeRemoteControl`. `export const remoteControlCommand`.

OUTPUTS_DECLARED: the four files above + swarm/BEACON.md
BLOCKING_ON: NONE
REVERSIBLE: YES (delete the four new files; remove the one import + registration line HELM adds to bin.ts)

---
FROM: BEACON
TO: ATLAS, HEAD_DEV
PHASE: IMPLEMENT
CONFIDENCE: MEDIUM
REFS: apps/server/src/terminal/Services/Manager.ts (interface only — no live layer in this clone),
      apps/server/src/remoteControl/ClaudeRemoteControlLauncher.ts (buildRemoteControlInteractiveCommandLine)
---

SPEC — In-app (terminal-hosted) Remote Control launch (deferred; NOT implemented, by design)

WHY DEFERRED: This clone ships only `terminal/Services/Manager.ts` (the `TerminalManagerShape` *interface*
and a `PTY.ts` import). There is no `terminal/Layers/NodePTY.ts` and no concrete terminal/PTY live layer to
wire into (verified by glob/grep). `TerminalManagerShape` opens shells keyed by `threadId`/`terminalId`
(see `TerminalOpenInput`/`TerminalStartInput` with `cols`/`rows`) and has no "run arbitrary argv with custom
env" entry point. Adding one is a core terminal change and is LOW-confidence without a typecheck, so per
IMPLEMENT.3 I provide the standalone, typecheck-safe `buildRemoteControlInteractiveCommandLine(settings, opts)`
and specify the hook here instead of editing core.

HOOK SPEC for whoever owns the terminal subsystem (HELM/HEAD_DEV) + UI (ATLAS):
  1. Command line: `const { command, args } = buildRemoteControlInteractiveCommandLine(settings, { name });`
     — always interactive (`claude --remote-control [--name <title>]`) so the session is attached and visible
     inside the embedded terminal/PTY.
  2. Environment: derive the PTY env from `makeClaudeEnvironment(settings, baseEnv)` (provider/Drivers/
     ClaudeHome.ts) so the in-app session uses the SAME selected Claude HOME/account as headless sessions.
     Merge over the terminal's base env exactly as the SDK path does.
  3. Terminal API gap to close: extend `TerminalManagerShape` (or add a sibling helper on the terminal Manager
     live layer) with something like `openCommand({ threadId, terminalId, cwd, command, args, env, cols, rows })`
     that spawns the given argv in a PTY instead of the default login shell, reusing the existing history/fanout/
     resize/close lifecycle. The launcher already gives `{ command, args }`; only env + spawn wiring remain.
  4. UI (ATLAS, web-surfaces-spec): a "Remote Control" action on a Claude instance that (a) shows the OAuth
     requirement note (Pro/Max/Team/Enterprise, claude.ai login — not an API key), (b) opens an in-app terminal
     running the interactive command from step 1, and (c) surfaces the pairing/registration output the CLI
     prints. The CLI path (`t3 remote-control` / `rc`) is the fully-working surface for this sprint.

CONFIDENCE MEDIUM only because the terminal API extension is unverifiable here (deps not installed, no live
layer). The CLI launcher + command are HIGH and self-contained.

OUTPUTS_DECLARED: (spec only; no files)
BLOCKING_ON: NONE
REVERSIBLE: YES

---
FROM: BEACON
TO: HEAD_DEV
PHASE: VERIFY
CONFIDENCE: HIGH
REFS: apps/server/src/remoteControl/*, apps/server/src/cli/remoteControl.ts
---

Self-review (by reading; deps not installed so no `vp check`/tests run, per session rule):

- Spawn mechanism matches providerMaintenanceRunner.ts (ChildProcessSpawner + ChildProcess.make + Effect.scoped
  + Number(exitCode)) and externalLauncher.ts (mapError on spawn). HIGH.
- HOME logic is NOT duplicated — `makeClaudeEnvironment` reused verbatim; empty homePath returns baseEnv,
  non-empty sets resolved `HOME`. HIGH.
- Error classes match provider/Errors.ts style (Schema.TaggedErrorClass + override get message). HIGH.
- CLI structure/combinators verified against effect-smol source: `Command.withAlias("rc")` exists (Command.ts:1030),
  `Flag.boolean` yields plain boolean and `Flag.withDefault(false)` keeps it boolean (Flag.ts:82,590) -> flags
  `.interactive`/`.server` are booleans (matches auth.ts jsonFlag). `Flag.optional` -> Option (matches project.ts).
  `CliError.UserError` is constructed `{ cause }` and subclassed with `override get message()` (matches bin.ts
  CloudPublicConfigMissingError). HIGH.
- Handler gets ChildProcessSpawner + Path.Path from bin.ts `CliRuntimeLayer = Layer.mergeAll(NodeServices.layer,
  NetService.layer)` — `NodeServices.layer` provides both. No extra layer wiring; bin.ts untouched. HIGH.
- Test mirrors externalLauncher.test.ts exactly (Layer.mock spawn capture, makeHandle shape, Effect.result +
  assertSuccess / `_tag === "Failure"`). Does NOT execute `claude`. HIGH.

Residual LOW/MEDIUM items (all flagged, none implemented blindly):
- In-app terminal launch: SPECced, not implemented (no terminal live layer in clone). MEDIUM/deferred.
- Per-instance `binaryPath` resolution from persisted settings: out of scope; command hardcodes `binaryPath:
  "claude"` and exposes only `--claude-home`. Follow-up: thread a selected Claude instance's binaryPath in.
- One unverifiable assumption: that the CLI runner tolerates non-CliError handler failures
  (ClaudeRemoteControl* errors) escaping the handler — consistent with project.ts letting ProjectCommandError
  escape, so HIGH-leaning, but unconfirmed without a build.

OUTPUTS_DECLARED: (review only)
BLOCKING_ON: NONE
REVERSIBLE: YES

---
FROM: BEACON
TO: HEAD_DEV
PHASE: HANDOFF
CONFIDENCE: HIGH
REFS: apps/server/src/remoteControl/*, apps/server/src/cli/remoteControl.ts, apps/server/src/bin.ts (C4 — HELM)
---

BEACON domain complete. Files created (all additive):
- apps/server/src/remoteControl/Errors.ts — RC launcher error classes (Launch/Exit + union).
- apps/server/src/remoteControl/ClaudeRemoteControlLauncher.ts — argv builder + HOME-aware resolver +
  `launchClaudeRemoteControl` spawn (inherited stdio) + interactive command-line helper for the in-app host.
- apps/server/src/remoteControl/ClaudeRemoteControlLauncher.test.ts — unit tests for argv + resolved env/mode
  (no real `claude` spawn).
- apps/server/src/cli/remoteControl.ts — `t3 remote-control` / `rc` command; `export const remoteControlCommand`.

REGISTRATION (for HELM — bin.ts is C4-owned by HELM; BEACON must not edit it):
  Add import:  `import { remoteControlCommand } from "./cli/remoteControl.ts";`
  Add to the `Command.withSubcommands([...])` array in `makeCli` (bin.ts ~line 45), e.g. after `projectCommand`:
      startCommand, serveCommand, authCommand, projectCommand, remoteControlCommand,
      cloudEnabled ? cloudCommand : cloudUnavailableCommand,
  No other wiring needed: the handler pulls ChildProcessSpawner + Path.Path from the existing
  `NodeServices.layer` already in bin.ts `CliRuntimeLayer`.

IMPLEMENTED vs SPECCED:
- IMPLEMENTED (HIGH): `t3 remote-control [--claude-home <path>] [--name <title>] [--interactive|--server] [cwd]`
  launching the real `claude` CLI in RC mode with the selected HOME/account and inherited stdio; prints the
  OAuth-not-API-key note; mutually-exclusive mode guard; full unit tests. Standalone interactive command-line
  helper for a future terminal host.
- SPECCED (MEDIUM, deferred): in-app terminal-hosted launch — no concrete terminal/PTY live layer exists in
  this clone, so the exact `TerminalManagerShape` extension + UI action are specified in this log for
  HELM/HEAD_DEV (terminal API) and ATLAS (web-surfaces-spec) rather than half-built.

LOW-confidence / follow-ups for next sprint:
- Per-instance Claude `binaryPath` (command currently hardcodes `claude`; only HOME is selectable via
  `--claude-home`). Thread a chosen instance's binaryPath through once instance selection exists (HELM C1/C2).
- Terminal API gap: add an "open arbitrary argv+env in PTY" entry point to the terminal Manager to enable the
  in-app button (see SPEC).
- Optional `--account` alias for `--claude-home` (C3 wording mentions `--account/--claude-home`); left as a
  thin future alias to avoid guessing account->home mapping semantics this sprint.

OUTPUTS_DECLARED: (final summary — files listed above)
BLOCKING_ON: NONE
REVERSIBLE: YES
