# Pi Provider Research

Date: 2026-05-27
Branch: `codex/pi-provider`
T3 Code base: `pingdotgg/t3code` at `4f0f24f0` (`fix: maintain reasoning selections for multiple providers (#2760)`)

## Scope And Sources

- Current T3 Code repository in `/Users/ambrealismwork/Desktop/coding-projects/pi-3-code-project`.
- Current Pi source cloned read-only at `/tmp/pi-provider-research/pi`.
- Prior proof-of-concept cloned read-only at `/tmp/pi-provider-research/poc`.
- Local Pi executable and sanitized local Pi config under `~/.pi/agent`. Secret values were not printed.
- Subagent read-only inspections covered current T3 provider architecture, Pi CLI/config/slash behavior, and prior POC reuse risk.

## Current T3 Provider Architecture

T3 Code now uses an open provider-driver and provider-instance architecture. Driver kinds are branded slugs, not a closed enum, and routing is by `ProviderInstanceId`.

Key files:

- `apps/server/src/provider/ProviderDriver.ts`: the driver SPI. A driver exposes `driverKind`, `metadata`, `configSchema`, `defaultConfig`, and `create()`. `create()` returns a scoped `ProviderInstance` containing `snapshot`, `adapter`, and `textGeneration`.
- `apps/server/src/provider/builtInDrivers.ts`: static built-in driver registry. Current entries are Codex, Claude, Cursor, and OpenCode.
- `apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts`: hydrates configured instances from `settings.providerInstances` plus legacy `settings.providers.<driver>`.
- `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts`: decodes config envelopes, calls `driver.create()`, owns per-instance scopes, and creates unavailable shadows for unknown or invalid drivers.
- `apps/server/src/provider/Layers/ProviderRegistry.ts`: aggregates per-instance snapshots for UI and status.
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`: resolves adapters dynamically by provider instance id.
- `apps/server/src/provider/Layers/ProviderService.ts`: cross-provider facade for session start, turn send, interrupt, rollback, and runtime event streaming.
- `apps/server/src/provider/Services/ProviderAdapter.ts`: adapter contract that Pi must satisfy.

Model selection is instance-scoped. `packages/contracts/src/orchestration.ts` defines `ModelSelection` as `{ instanceId, model, options? }`; legacy `{ provider, model }` decodes into the default instance id. Runtime start/send paths pass `modelSelection` through `ProviderCommandReactor` into `ProviderService`.

Provider snapshots use `packages/contracts/src/server.ts` `ServerProvider`, including:

- `instanceId`
- `driver`
- `enabled`, `installed`, `version`, `status`, `auth`
- `models: ServerProviderModel[]`
- `slashCommands: ServerProviderSlashCommand[]`

There is no native separator row in `ServerProviderModel`. Preferred model ordering is feasible; an actual visual separator would require a contract/UI change or an unsafe fake model entry.

Provider settings currently live in `packages/contracts/src/settings.ts` while the migration to opaque per-driver config is incomplete. Existing provider schemas include executable paths and auth/config roots where needed. Adding Pi should follow this pattern with a small schema and no copied Pi secrets.

## Current Pi CLI, Config, Models, And RPC

Installed local Pi:

- Executable: `/opt/homebrew/bin/pi`
- Version: `0.75.5`
- Symlink target: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`

Current source package:

- `/tmp/pi-provider-research/pi/packages/coding-agent/package.json` maps bin `pi` to `dist/cli.js`.
- Important CLI flags parsed in `/tmp/pi-provider-research/pi/packages/coding-agent/src/cli/args.ts`:
  - `--mode text|json|rpc`
  - `--print`, `-p`
  - `--provider`, `--model`, `--models`
  - `--session`, `--continue`, `--resume`, `--fork`, `--session-dir`, `--no-session`
  - `--tools`, `--no-tools`, `--no-builtin-tools`
  - `--extension`, `--skill`, `--prompt-template`, `--theme`, plus corresponding `--no-*`
  - `--thinking off|minimal|low|medium|high|xhigh`
  - `--list-models`, `--offline`

Pi config:

- Default config root: `~/.pi/agent`, overridable by `PI_CODING_AGENT_DIR`.
- Local settings file: `/Users/ambrealismwork/.pi/agent/settings.json`.
- Local model file: `/Users/ambrealismwork/.pi/agent/models.json`.
- Local auth file: `/Users/ambrealismwork/.pi/agent/auth.json`.
- Project settings may exist at `<cwd>/.pi/settings.json` and override global settings.

Sanitized local settings observed:

- `defaultProvider: openai-codex`
- `defaultModel: gpt-5.5`
- `defaultThinkingLevel: low`
- `transport: websocket`
- `enabledModels`: 22 configured model patterns
- packages/extensions are configured

Sanitized local auth providers observed by type only:

- `openai-codex`: OAuth
- `anthropic`: OAuth
- `google-antigravity`: OAuth
- `opencode-go`: API key

Pi model behavior:

- Models are loaded from built-ins plus `~/.pi/agent/models.json`.
- Custom providers observed locally include `dashscope`, `kilo`, `openai-codex`, `qwen36`, `stepfun`, `zai-coding`, `zai-glm47-flash`, and `zai-glm5-turbo`.
- `pi --list-models` lists auth-available models.
- RPC `get_available_models` returns a structured live model list and was verified locally without printing secrets.
- Best T3 model source is Pi RPC `get_available_models`; fallback can parse `~/.pi/agent/settings.json` and `models.json` only if RPC discovery fails.

Pi noninteractive modes:

- `pi -p "prompt"` returns final text.
- `pi --mode json "prompt"` emits JSONL events.
- `pi --mode rpc` is bidirectional JSONL over stdin/stdout. This is the best adapter seam because it supports prompt, model changes, model discovery, session state, bash, compact, export, session switching, and command discovery.

Pi RPC commands from source include:

- `prompt`, `steer`, `follow_up`, `abort`
- `new_session`, `get_state`, `set_model`, `cycle_model`, `get_available_models`
- `set_thinking_level`, `cycle_thinking_level`
- `compact`, `bash`, `abort_bash`
- `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`
- `get_last_assistant_text`, `set_session_name`, `get_messages`, `get_commands`

## Pi Slash Commands

Pi built-in interactive slash command autocomplete includes:

- `/settings`
- `/model`
- `/scoped-models`
- `/export`
- `/import`
- `/share`
- `/copy`
- `/name`
- `/session`
- `/changelog`
- `/hotkeys`
- `/fork`
- `/clone`
- `/tree`
- `/login`
- `/logout`
- `/new`
- `/compact`
- `/resume`
- `/reload`
- `/quit`

Source findings:

- Built-in interactive command handling lives in Pi interactive mode.
- Extension slash commands run before prompt expansion and can execute while streaming.
- Prompt templates expand `/template args`.
- Skill commands expand `/skill:name args`.
- RPC `get_commands` returns extension, prompt-template, and skill commands, but not the full interactive built-in command list.

Integration implication: T3 can surface dynamic Pi commands discovered by RPC and can map some built-ins to RPC commands (`/model`, `/compact`, `/fork`, `/clone`, `/name`, `/session`, `/export`, bash-like commands). Exact interactive TUI parity is not guaranteed because several built-ins are UI-local or auth/session-manager affordances with no direct RPC equivalent.

## Prior POC Findings

Prior POC repository: `https://github.com/AmbitiousRealism2025/t3-code-atreides-pi-edition.git`.

Reusable patterns:

- `apps/server/src/provider/Layers/PiAdapter.ts` has useful JSONL RPC subprocess handling and event mapping.
- It correctly waits for Pi `agent_end` rather than finalizing on `turn_end`, because Pi can run multiple internal turns for one user request.
- It stores per-T3 session files and uses `--session` / `--continue` to preserve Pi conversation state.
- It maps Pi event stream concepts into T3 runtime events.
- `PiModelDiscoveryLive.ts` demonstrates the need for live model discovery, though its implementation path is stale.

Stale or risky patterns:

- The POC used an old provider manifest registry (`packages/contracts/src/providers/pi.ts`), which current T3 no longer uses.
- It used singleton provider-kind adapter routing, while current T3 routes by provider instance id.
- It added direct `/api/provider/pi/models` HTTP endpoints, while current T3 expects models through `ServerProvider.models` snapshots.
- It used stale start/send inputs (`model`, `modelOptions`) instead of current `modelSelection`.
- It depended on an older package name/version (`@mariozechner/pi-coding-agent`) while current Pi is `@earendil-works/pi-coding-agent` `0.75.5`.
- It copied or symlinked `auth.json`, `models.json`, and sanitized `settings.json` into a T3-owned Pi runtime directory. That conflicts with this task's requirement to read existing `~/.pi/` config instead of creating separate T3-only Pi config.
- It disabled extensions, skills, prompt templates, and themes for some paths, which would reduce slash-command parity.

## Integration Risks

- Pi is a CLI/TUI executable with structured RPC, not a generic hosted API provider. T3 needs a subprocess adapter, not a plain HTTP client.
- Pi config and auth must be read from the existing Pi config root. The adapter must not copy or print secrets.
- Local model lists may depend on auth state, custom model config, and project settings.
- Preferred-model grouping is partly supported by ordering. A visual separator is not supported by current T3 model contracts without UI/schema work.
- Extension UI requests, auth flows, and some interactive slash commands may not map cleanly to T3.
- Long-running provider subprocesses need cancellation and cleanup.
- Full verification may spend real local Pi account quota/tokens.

## Proposed Current Integration Shape

- Add a first-class `pi` `ProviderDriver`.
- Register it in `BUILT_IN_DRIVERS`.
- Add `PiSettings` with `enabled`, `binaryPath`, and hidden `customModels`; do not add a separate T3 Pi config root.
- Leave `PI_CODING_AGENT_DIR` unset by default so Pi reads its existing default `~/.pi/agent`; allow the provider instance environment to override it if a user has already configured that globally.
- Discover the Pi executable from settings first, then PATH.
- Build provider snapshots from live Pi RPC `get_available_models`, ordered by local Pi defaults and `enabledModels`.
- Implement prompt execution with `pi --mode rpc`, session files owned by T3 but config/auth owned by Pi.
- Surface Pi dynamic slash commands from RPC where available, add documented built-in mappings where safe, and document partial/blocked parity in `PI_PARITY.md`.
