# Spec: Claudex provider driver (server-side) — claudex-luna / claudex-sol, no reasoning efforts

## Problem

The mac app already has a cosmetic `ProviderKind.claudex` (commit fff43b375) that matches a provider whose `instanceId == "claudex"`, but no server-side driver exists. Today claudex sessions would go through the vanilla Claude Agent driver, exposing the full Claude model catalog (claude-fable-5, claude-opus-4-8, …) with reasoning-effort option descriptors. The `claudex` CLI actually serves exactly two models — `claudex-luna` and `claudex-sol` (gpt-5.6-luna / gpt-5.6-sol) — and neither supports reasoning-effort settings.

Fix: add a real `claudex` driver that rebrands the Claude Agent driver, exposes exactly those two models with **no option descriptors at all** (no effort, no thinking), and never forwards an effort flag or ultrathink prompt-prefix to the CLI.

## Architecture facts (verified against this repo — trust these, re-verify line numbers as they may drift)

- Driver SPI: `apps/server/src/provider/ProviderDriver.ts` — `ProviderDriver<Config, R>` with `driverKind`, `metadata`, `configSchema`, `defaultConfig`, `create(input) => Effect<ProviderInstance, ProviderDriverError, R | Scope>`.
- Registration: `apps/server/src/provider/builtInDrivers.ts` — import driver, add its env type to `BuiltInDriversEnv` union, add to `BUILT_IN_DRIVERS` array.
- Default-instance hydration: `apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts` (`deriveProviderInstanceConfigMap`, ~lines 73–104): for each built-in driver, `instanceId = ProviderInstanceId.make(driverKind)`. It synthesizes a default instance ONLY if `settings.providers[driverKind]` exists — **so `ServerSettings.providers` needs a `claudex` key or the instance never materializes.**
- Best template: `apps/server/src/provider/Drivers/ClaudeSyntheroDriver.ts` — a Claude Agent driver rebrand. It projects its own settings down to `ClaudeSettings` (`toClaudeSettings`), builds a process env, calls `makeClaudeAdapter(claudeSettings, { instanceId, driverKind: DRIVER_KIND, environment, nativeEventLogger })`, `makeClaudeTextGeneration(claudeSettings, processEnv)`, and wires `checkClaudeProviderStatus(...)` / `makePendingClaudeProvider(...)` with its own `ClaudeProviderIdentity` into `makeManagedServerProvider`.
- Model catalog: `apps/server/src/provider/Layers/ClaudeProvider.ts` `BUILT_IN_MODELS` is module-level and hardcoded; `checkClaudeProviderStatus` / `makePendingClaudeProvider` always return it — no override parameter. So Claudex must post-process the provider snapshot to replace `models` entirely (precedent: `normalizeFuguProviderSnapshot` in `apps/server/src/provider/Drivers/FuguDriver.ts`, which rewrites capabilities on every model in the snapshot before it reaches clients).
- Effort suppression comes free once the model slugs are right: `getClaudeModelCapabilities(model)` (ClaudeProvider.ts ~356) looks up by slug in `BUILT_IN_MODELS` and falls back to `DEFAULT_CLAUDE_MODEL_CAPABILITIES` (empty `optionDescriptors`) for unknown slugs. `claudex-luna`/`claudex-sol` are unknown → empty descriptors → in `ClaudeAdapter.ts` (~4255–4298) `rawEffort`/`effort`/`effectiveEffort` resolve to null and the `effort` field is omitted from the SDK call; the ultrathink prompt-prefix path (`applyClaudePromptEffortPrefix`, gated on `descriptor.promptInjectedValues`) also never fires. **Do NOT add claudex models to `BUILT_IN_MODELS`.** Do NOT modify ClaudeAdapter.
- `resolveClaudeApiModelId` passes the slug verbatim to the CLI/SDK `model` field — `claudex-luna` / `claudex-sol` reach the claudex CLI as-is, which is correct.
- Binary selection: `ClaudeSettings.binaryPath` via `makeBinaryPathSetting(fallback)` in `packages/contracts/src/settings.ts` (~109–119). Claudex default binary = `"claudex"`.
- Continuation identity: `makeClaudeContinuationGroupKey` (`apps/server/src/provider/Layers/ClaudeHome.ts` ~31–35) returns `claude:home:${resolvedHomePath}` — keyed on homePath only. If Claudex used it with the default home it would collide with the vanilla Claude instance's continuation group. Claudex must use a distinct key, e.g. `claudex:home:${resolvedHomePath}` (compute resolvedHomePath the same way; do not change homePath default — the claudex CLI keeps its own auth/state in the real HOME).

## Changes

### 1. `packages/contracts/src/settings.ts`
- Add `ClaudexSettings`: same shape as `ClaudeSettings` but `binaryPath: makeBinaryPathSetting("claudex")`. (No baseURL/authToken — unlike Synthero, claudex CLI manages its own auth. No homePath default override — keep identical to ClaudeSettings.)
- Add `ClaudexSettingsPatch` mirroring `ClaudeSettingsPatch` (follow existing patch-schema pattern).
- Add `claudex` key to the legacy `providers` struct (~514–522) and to `ServerSettingsPatch.providers` (~659–669).

### 2. `packages/contracts/src/model.ts`
- `const CLAUDEX_DRIVER_KIND = ProviderDriverKind.make("claudex")` alongside the others (~130–136).
- `DEFAULT_MODEL_BY_PROVIDER[CLAUDEX_DRIVER_KIND] = "claudex-luna"` (~141–149).
- `MODEL_SLUG_ALIASES_BY_PROVIDER[CLAUDEX_DRIVER_KIND] = { luna: "claudex-luna", sol: "claudex-sol" }` (~163–227; mirror the codex gpt-5.6 alias precedent at ~175–183).
- `PROVIDER_DISPLAY_NAMES[CLAUDEX_DRIVER_KIND] = "Claudex"` (~231–238).

### 3. `apps/server/src/provider/Drivers/ClaudexDriver.ts` (new)
Follow `ClaudeSyntheroDriver.ts` structure:
- `DRIVER_KIND = ProviderDriverKind.make("claudex")`, metadata displayName `"Claudex"`.
- `configSchema: ClaudexSettings`, `defaultConfig` decodes `{}`.
- `toClaudeSettings()` projection (ClaudexSettings is structurally ClaudeSettings, so this may be near-identity — keep the explicit projection function for clarity/type safety).
- Its own `CLAUDEX_IDENTITY: ClaudeProviderIdentity` (mirror how Synthero builds one).
- Continuation identity: distinct group key `claudex:home:${resolvedHomePath}` (see facts above). Resolve home the same way ClaudeHome does; add a small exported helper so it's testable.
- Adapter: `makeClaudeAdapter(claudeSettings, { instanceId, driverKind: DRIVER_KIND, environment: processEnv, nativeEventLogger })`; text generation via `makeClaudeTextGeneration(claudeSettings, processEnv)`.
- **Model normalization (the core of the fix)** — exported for tests, e.g. `normalizeClaudexProviderSnapshot(draft)`: replace `models` with exactly:
  - `{ slug: "claudex-luna", name: "Claudex Luna", capabilities: createModelCapabilities({ optionDescriptors: [] }) }`
  - `{ slug: "claudex-sol", name: "Claudex Sol", capabilities: createModelCapabilities({ optionDescriptors: [] }) }`
  Match the exact `ServerProviderModel` field shape used by `BUILT_IN_MODELS` / `providerModelsFromSettings` (check required fields — defaultModel, etc.). Default model: `claudex-luna`. Apply the normalization to both the `checkProvider` result and the pending-provider snapshot (wherever the Fugu precedent applies `normalizeFuguProviderSnapshot` — both the check path and pending path so clients never see Claude models even transiently).
- Respect `claudeSettings.customModels` = ignore them (claudex serves exactly two models); if the shared plumbing injects custom models, strip them in the normalize step (normalize runs last, so replacing `models` wholesale handles this).

### 4. `apps/server/src/provider/builtInDrivers.ts`
- Register `ClaudexDriver` (import, env union, array).

### 5. Tests — `apps/server/src/provider/Drivers/ClaudexDriver.test.ts` (new)
Pattern: `ClaudeSyntheroDriver.test.ts` (vite-plus/test, `Schema.decodeSync`, `Effect.runSync`, pure-function tests only — no process spawning). Cover:
- `ClaudexSettings` defaults: `binaryPath === "claudex"`.
- `normalizeClaudexProviderSnapshot`: given a draft carrying the full Claude `BUILT_IN_MODELS` catalog (and a custom model), output has exactly `claudex-luna` + `claudex-sol`, each with empty/absent `optionDescriptors` (assert no descriptor with id `effort`, `reasoningEffort`, or `thinking`), and defaultModel `claudex-luna`.
- Continuation group key: starts with `claudex:` and differs from `makeClaudeContinuationGroupKey` output for the same settings.
- Effort suppression regression: `getClaudeModelCapabilities("claudex-luna")` (import from ClaudeProvider) yields empty `optionDescriptors`, and `resolveClaudeEffort(caps, "high")` returns undefined/null — pins the "unknown slug → no effort" behavior this fix relies on.

### 6. NOT in scope
- No mac app changes (instanceId `"claudex"` match + server-driven effort picker already do the right thing). Do not touch apps/mac.
- No ClaudeAdapter.ts changes.
- No changes to Codex's gpt-5.6 aliases.
- Do not add claudex models to ClaudeProvider BUILT_IN_MODELS.

## Verification (run all)
- Targeted tests: run the repo's test runner for `apps/server/src/provider/Drivers/ClaudexDriver.test.ts` and the existing `ClaudeSyntheroDriver.test.ts`, `FuguProvider.test.ts`, `CodexProvider.test.ts`, `ProviderInstanceRegistryLive.test.ts` (registry test may enumerate drivers — update only if it fails for a mechanical reason).
- Typecheck + lint for touched packages (check package.json / root scripts — repo has a `vp check`-style gate; run whatever the repo's standard check command is for apps/server and packages/contracts).
- Note: repo convention (vp check) makes lint debt in touched legacy files blocking — if touching settings.ts trips unrelated lint debt, fix minimally or report back rather than converting whole files.

## Style
- Match surrounding code idiom (Effect-TS, Schema codecs). Comment density like neighbors — sparse.
- Conventional Commits if committing, but DO NOT commit — leave working tree dirty for review.
