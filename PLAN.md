# Pi Provider Implementation Plan

Date: 2026-05-27
Branch: `codex/pi-provider`

## Milestone 1: Pre-Edit Gate

- Inspect current T3 Code provider architecture.
- Inspect current Pi executable, config, model, RPC, and slash-command behavior without printing secrets.
- Inspect prior POC for reusable and stale patterns.
- Write `RESEARCH.md` and this `PLAN.md` before implementation file edits.

Status: complete.

## Milestone 2: Contracts And Settings

- Add `PI_DRIVER_KIND` defaults in `packages/contracts/src/model.ts`.
- Add `PiSettings` in `packages/contracts/src/settings.ts`.
- Add Pi to legacy `providers` settings hydration so a default `pi` provider instance can be auto-created.
- Add Pi patch schema support for settings updates.

Verification:

- Contract typecheck or targeted schema test.
- Existing provider defaults remain unchanged for Codex, Claude, Cursor, and OpenCode.

Status: complete.

## Milestone 3: Server Driver And Snapshot

- Add `apps/server/src/provider/Drivers/PiDriver.ts`.
- Add a Pi provider snapshot layer/helper that:
  - finds the Pi binary,
  - runs `pi --version`,
  - probes local Pi model state with RPC `get_available_models`,
  - reads sanitized `~/.pi/agent/settings.json` only for ordering/defaults,
  - exposes models through `ServerProvider.models`,
  - exposes supported Pi slash commands through `ServerProvider.slashCommands`.
- Register Pi in `apps/server/src/provider/builtInDrivers.ts`.

Verification:

- Provider snapshots include Pi.
- Pi models appear when local Pi config is readable.
- Preferred/default/enabled models are ordered first when possible.

Status: complete.

## Milestone 4: Pi Adapter

- Add a Pi adapter that satisfies `ProviderAdapterShape`.
- Use `pi --mode rpc` for prompt turns.
- Use T3-owned session files for T3 conversations while leaving Pi config/auth under `~/.pi/agent`.
- Map Pi JSONL events into canonical T3 runtime events.
- Support cancellation by sending RPC `abort` and terminating the child process when needed.
- Preserve behavior for all other providers.

Verification:

- A T3 session can start with provider instance `pi`.
- A basic prompt can be sent through Pi and returns assistant text.
- Interrupt/cleanup paths do not leak child processes in normal completion.

Status: complete.

## Milestone 5: Web Provider Option

- Add Pi to client provider driver metadata.
- Remove or replace the disabled "Pi Agent" coming-soon entry.
- Confirm Pi appears as a selectable provider option in settings/model selection.

Verification:

- Local web app shows Pi provider option.
- Model selector receives Pi models from server snapshot.

Status: complete.

## Milestone 6: Slash Command Parity

- Test dynamic Pi commands via RPC `get_commands`.
- Add best-effort slash command exposure and/or mappings.
- Document implemented, partial, and blocked commands in `PI_PARITY.md`.

Verification:

- Slash command menu shows Pi-supported entries where feasible.
- Unsupported interactive-only commands are explicitly documented, not silently claimed.

Status: complete.

## Milestone 7: Checks And Local Verification

- Run fastest targeted checks after each coherent edit and record in `ATTEMPTS.md`.
- Run required project gates from `AGENTS.md`:
  - `bun fmt`
  - `bun lint`
  - `bun typecheck`
  - `bun run test`
- Start T3 locally from `codex/pi-provider`.
- Verify:
  - Pi appears as a provider option.
  - T3 reads existing `~/.pi/agent` config.
  - Pi model options appear in selector/snapshot.
- A basic prompt reaches Pi and returns a response.
- Slash-command behavior is tested or manually verified.

Status: complete.

## Stop Criteria

Stop only when T3 runs locally with Pi selectable, existing Pi config readable, Pi models visible, and a basic Pi prompt verified.

Status: met using isolated verification state at `/tmp/t3-pi-provider-verify`.

If blocked, stop with:

- exact blocker,
- evidence,
- attempted fixes,
- current branch state,
- next decision needed.
