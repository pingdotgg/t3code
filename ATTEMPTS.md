# Pi Provider Attempts

Date: 2026-05-27
Branch: `codex/pi-provider`

## Loop 0: Repository And Pre-Edit Research

Edit:

- Cloned latest `pingdotgg/t3code` into `/Users/ambrealismwork/Desktop/coding-projects/pi-3-code-project`.
- Created local branch `codex/pi-provider`.
- Cloned Pi and the prior POC read-only into `/tmp/pi-provider-research`.
- Wrote `RESEARCH.md` and `PLAN.md` before implementation edits.

Checks:

- `git status --short --branch`
- `command -v pi`
- `/opt/homebrew/bin/pi --version`
- `/opt/homebrew/bin/pi --help`
- sanitized inspection of `~/.pi/agent/settings.json`, `models.json`, and auth provider names/types only
- Pi RPC probe for `get_available_models` and `get_commands`

Result:

- Current branch is `codex/pi-provider`.
- Local Pi executable exists at `/opt/homebrew/bin/pi`, version `0.75.5`.
- Existing Pi config is readable at `~/.pi/agent`.
- Pi RPC model discovery works locally.
- No implementation files were edited before `RESEARCH.md` and `PLAN.md`.

Lesson:

- Current T3 requires a provider-driver/provider-instance integration. The prior POC is useful for RPC/event behavior but stale for architecture and config handling.

## Loop 1: Contracts And Client Provider Metadata

Edit:

- Added a `pi` driver kind to provider model defaults and display names.
- Added `PiSettings` with `enabled`, `binaryPath`, and hidden `customModels`.
- Added `providers.pi` to legacy provider settings hydration and settings patch schema.
- Added Pi to browser provider client definitions with the existing `PiAgentIcon`.
- Removed the disabled "Pi Agent" coming-soon entry from the add-provider dialog.

Checks:

- Pending with the server driver slice so typecheck sees a registered implementation.

Result:

- Pi is represented in contracts/settings and in client metadata.

Lesson:

- The first selectable-provider step is low-risk, but server registration must follow before meaningful runtime verification.

## Loop 2: Server Driver, Snapshot, Adapter, And Typecheck

Edit:

- Added `PiDriver` and registered it in `BUILT_IN_DRIVERS`.
- Added a Pi provider snapshot probe that runs `pi --version`, reads local Pi settings for ordering, and uses Pi RPC `get_available_models` / `get_commands`.
- Added a Pi adapter that starts T3 provider sessions, stores Pi session files under T3 state, leaves Pi config/auth at the existing Pi default, and sends turns through `pi --mode rpc`.
- Added Pi text-generation support through one-shot Pi RPC prompts for titles, branch names, commit messages, and PR content.
- Added fixture support for `providers.pi`.

Checks:

- `bun install`
- `bun typecheck`

Result:

- First typecheck failed because dependencies were missing (`turbo: command not found`).
- `bun install` succeeded.
- Second typecheck found a missing web fixture `providers.pi` entry and several typed Effect/server diagnostics in the new Pi files.
- Patched the fixture, fixed Effect function annotations, mapped promise errors, removed a readonly turn-array mutation, and suppressed narrowly scoped diagnostics for unavoidable Node child-process/JSONL glue.
- Final `bun typecheck` passed: 13 successful tasks.

Lesson:

- T3's provider-driver contract accepted the Pi slice cleanly once the instance/settings shape and Effect error channels were made explicit. The remaining verification risk is runtime behavior, not static typing.

## Loop 3: Formatting, Linting, And Tests

Edit:

- Ran formatting across the workspace.
- Updated the built-in provider registry test expectation to include the new Pi driver.
- Removed lint warnings introduced by the Pi glue code.

Checks:

- `bun fmt`
- `bun lint`
- `bun run test`
- `bunx vitest run src/provider/Layers/ProviderRegistry.test.ts` from `apps/server`
- `bun typecheck`

Result:

- `bun fmt` completed and formatted the edited files.
- `bun lint` passed. It still reports pre-existing warnings outside the Pi provider slice.
- First `bun run test` failed only because `ProviderRegistry.test.ts` expected the previous built-in driver set.
- Targeted provider registry test passed after the expectation update: 33 tests passed.
- Full `bun run test` passed after the patch: 13 successful tasks, including the server and web test suites.
- Final `bun typecheck` passed: 13 successful tasks.

Lesson:

- The only test expectation that needed updating was the explicit built-in provider list. Existing provider behavior remained covered by the surrounding suites.

## Loop 4: Local Runtime Provider Snapshot

Edit:

- No implementation edit.
- Started T3 locally from `codex/pi-provider`.

Checks:

- `bun run dev` using the default T3 state.
- `T3CODE_HOME=/tmp/t3-pi-provider-verify T3CODE_DEV_INSTANCE=piverify bun run dev`
- WebSocket RPC `serverRefreshProviders` against the isolated dev server.

Result:

- The default `~/.t3` run hit an existing local migration/state issue unrelated to Pi: migration `24_BackfillProjectionThreadShellSummary` failed with `no such column: latest_turn_plan.implemented_at`.
- The isolated verification home started successfully on server port `15401` and web port `7361`.
- Provider refresh returned five built-in provider instances: `claudeAgent`, `codex`, `cursor`, `opencode`, and `pi`.
- Pi snapshot status was `ready`, installed/authenticated, version `0.75.5`.
- Pi exposed 63 model options and 71 slash commands.
- The first visible Pi models were ordered from local Pi preferences, starting with `openai-codex/gpt-5.5`.
- The provider message confirmed use of existing config at `/Users/ambrealismwork/.pi/agent`.

Lesson:

- The Pi provider integration works against a clean current T3 state. The existing default user-data migration error is a local-state blocker for that state directory, not a Pi integration blocker.

## Loop 5: Basic Prompt Through T3 Into Pi

Edit:

- No implementation edit.
- Refreshed the isolated dev-server auth token after an initial stale-token WebSocket open failed.
- Added `.pi/` to `.gitignore` and removed generated local Pi runtime feed files after prompt verification.

Checks:

- WebSocket RPC `project.create`.
- WebSocket RPC `thread.turn.start` with `modelSelection.instanceId = "pi"` and model `openai-codex/gpt-5.5`.
- Polled the T3-owned Pi session file under `/tmp/t3-pi-provider-verify/dev/providers/pi/sessions`.

Result:

- The first WebSocket open used a stale token and failed before dispatch.
- That rejected socket also exposed an unrelated dev-server fragility: the watched server process threw an unhandled `ECONNRESET`. Restarting the isolated dev server fixed the verification environment.
- The second run dispatched successfully with sequence `7`.
- T3 created a Pi session file for the verification thread.
- The session file contained the exact assistant response text: `T3 Pi provider verification OK`.
- Pi also created project-local `.pi/` messenger feed files during verification; these are now ignored and were removed from the working tree.

Lesson:

- A basic prompt now travels through T3 orchestration with Pi selected and returns a Pi assistant response. Token freshness matters for the verification script because WebSocket tokens are short-lived.

## Loop 6: Browser Smoke Attempt

Edit:

- No implementation edit.

Checks:

- Attempted to navigate the in-app browser tool to `http://localhost:7361/`.

Result:

- The browser tool returned an invalid-navigation error before loading localhost.
- The stronger local verification remains the successful live T3 WebSocket orchestration prompt and provider snapshot checks.

Lesson:

- The browser tool path was unavailable in this run, but it did not block the required provider, model, config, slash-command, and prompt verification gates.

## Loop 7: Pi RPC Display Cleanup

Edit:

- Changed `extractAssistantText` to prefer final Pi assistant `message_end` or `agent_end` text before falling back to streamed `message_update` deltas.
- Added `PiRpc.test.ts` coverage for the exact leakage shape: streamed reasoning text plus JSON tool-call arguments followed by a clean final answer.

Checks:

- `bunx vitest run src/provider/Layers/PiRpc.test.ts`
- `bun typecheck`
- Confirmed the dev server is still listening on port `15401` and web is still listening on port `7361`.

Result:

- Targeted Pi RPC test passed: 2 tests passed.
- Typecheck passed: 13 successful tasks.
- The fix prevents Pi reasoning/tool-call JSON deltas such as `{"path":...}` and `{"command":...}` from being rendered as assistant text when Pi sends a final assistant message.

Lesson:

- Pi RPC emits useful intermediate deltas for its own TUI, but T3's buffered provider adapter should render the final assistant message as the chat answer and keep intermediate tool metadata out of visible prose.

## Loop 8: Pi Assistant Text Streaming

Edit:

- Launched two read-only research subagents:
  - Pi-side stream semantics: confirmed safe visible text is only `message_update.assistantMessageEvent.type === "text_delta"`.
  - T3-side runtime contract: confirmed visible streaming should use `content.delta` with `streamKind: "assistant_text"`.
- Added a Pi RPC event callback so the adapter can receive JSONL events while the prompt is still running.
- Added `readPiAssistantTextDelta` to filter only Pi `text_delta` events.
- Updated `PiAdapter` to emit `item.started` and incremental `content.delta` events as Pi text deltas arrive.
- Kept final `message_end` extraction as fallback and avoided duplicate final output when streaming already emitted the text.
- Enabled `enableAssistantStreaming` in the isolated dev-server settings used for manual testing.

Checks:

- `bunx vitest run src/provider/Layers/PiRpc.test.ts`
- `bun typecheck`
- `bun fmt`
- Live adapter verification against local Pi and existing `~/.pi/agent` config.

Result:

- Targeted Pi RPC tests passed: 3 tests passed.
- Typecheck passed: 13 successful tasks.
- Formatting passed.
- Live adapter verification emitted six separate `content.delta` events before `turn.completed` for the prompt `alpha beta gamma delta epsilon`.
- The six visible deltas were `alpha`, ` beta`, ` gamma`, ` delta`, ` epsilon`, and `.`.
- The dev server was restarted cleanly after file-watcher churn and is running with the streaming patch loaded.

Lesson:

- Pi can stream cleanly through T3 as long as the adapter maps only `text_delta` to `assistant_text`; reasoning and tool-call deltas must remain hidden or be mapped to non-assistant surfaces later.
