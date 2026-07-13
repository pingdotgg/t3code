# Spec: enable reasoning efforts on Claudex models (corrects PR #81's suppression)

## Problem

PR #81 added the Claudex driver but suppressed reasoning efforts entirely (empty option descriptors, selection options dropped, `--effort` stripped from launchArgs). That was wrong: the claudex CLI's gpt-5.6 models DO support reasoning efforts and the user wants them selectable.

Verified end-to-end chain (do not re-verify, this is empirical fact from this session):
- SergeCode Claude adapter passes `effort` to the Claude Agent SDK → SDK spawns the claude binary with `--effort <value>`.
- The claude binary forwards any of `low|medium|high|xhigh|max` VERBATIM for unknown model slugs like `claudex-luna` — wire request carries `thinking: {type:"adaptive"}` + `output_config.effort: "<value>"`. No per-model downgrade. When no `--effort` given, CLI defaults to `high`.
- The local cliproxyapi proxy translates claude→codex: with adaptive thinking it passes `output_config.effort` literally into codex `reasoning.effort`, then clamps against the upstream registry levels for gpt-5.6-luna/sol which are exactly `[low, medium, high, xhigh, max]`. So all five levels map 1:1.

Desired: both `claudex-luna` and `claudex-sol` expose an effort picker with `low/medium/high/xhigh/max`; default `max` for luna, `high` for sol. No `ultracode`/`ultrathink` options (Claude-specific: prompt-injection and CLI orchestration semantics, meaningless for gpt-5.6).

## Current blockers in code (all in this repo)

1. `apps/server/src/provider/Drivers/ClaudexDriver.ts` — `normalizeClaudexProviderSnapshot` builds both models with `createModelCapabilities({ optionDescriptors: [] })`.
2. Same file — `normalizeClaudexModelSelection` returns only `{ instanceId, model }`, dropping the `options` array where the effort selection lives (`{ id: "effort", value: ... }` entries).
3. Same file — `stripClaudexEffortArgs` strips `--effort` from launchArgs.
4. `apps/server/src/provider/Layers/ClaudeAdapter.ts` (~4255) — capabilities are looked up via `getClaudeModelCapabilities(modelSelection?.model)` which reads `ClaudeProvider.BUILT_IN_MODELS` by slug; claudex slugs are unknown → empty caps → `resolveClaudeEffort` returns undefined → effort never reaches the SDK. Do NOT add claudex models to `BUILT_IN_MODELS` (they would leak into the vanilla Claude provider's model list). Instead make the lookup overridable per adapter instance.
5. `apps/server/src/provider/Layers/ClaudeProvider.ts` `normalizeClaudeCliEffort` remaps `xhigh` → `max` for any model that isn't fable-5/opus-4-8/sonnet-5 — wrong for claudex slugs (binary accepts xhigh verbatim). The remap is applied via `getEffectiveClaudeAgentEffort` (ClaudeAdapter.ts ~318–324). Needs a per-adapter bypass.

## Changes

### 1. `apps/server/src/provider/Drivers/ClaudexDriver.ts`
- Export a single source of truth for the two models, e.g. `CLAUDEX_MODELS: ReadonlyArray<ServerProviderModel>`, each with capabilities:
  - effort select descriptor: `id: "effort"`, `label: "Reasoning"`, options `low` ("Low"), `medium` ("Medium"), `high` ("High"), `xhigh` ("Extra High"), `max` ("Max"); `isDefault: true` on `max` for claudex-luna and on `high` for claudex-sol. Mirror the descriptor shape used by `BUILT_IN_MODELS` in `ClaudeProvider.ts` (`buildSelectOptionDescriptor` — reuse/import it if exported, otherwise construct the same literal shape via contracts types). NO `promptInjectedValues`, no other descriptors.
- `normalizeClaudexProviderSnapshot` uses `CLAUDEX_MODELS` (still replaces the snapshot's model list wholesale).
- `normalizeClaudexModelSelection`: preserve `options` from the incoming selection (spread the original and override `model` only). Keep the unknown-model → default coercion.
- Delete `stripClaudexEffortArgs`; `toClaudeSettings` passes `launchArgs` through unchanged.
- Export a capabilities lookup, e.g. `getClaudexModelCapabilities(model: string | undefined): ModelCapabilities | undefined` returning the matching CLAUDEX_MODELS entry's capabilities (undefined for non-claudex slugs), and a Claudex effort normalizer `normalizeClaudexEffort(effort)` that returns undefined for falsy values and passes `low|medium|high|xhigh|max` through unchanged (drop anything else, including ultrathink/ultracode, by returning undefined — defensive, those are never offered).
- Pass both into `makeClaudeAdapter` via the new adapter options (below). Also pass the capabilities lookup into `makeClaudeTextGeneration` IF that path also resolves effort from capabilities (check `apps/server/src/textGeneration/ClaudeTextGeneration.ts`; if it doesn't consult capabilities, leave it alone).

### 2. `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- Extend `ClaudeAdapterLiveOptions` (~261–271) with:
  - `readonly getModelCapabilities?: (model: string | undefined) => ModelCapabilities | undefined;`
  - `readonly normalizeEffort?: (effort: string | null | undefined, model: string | null | undefined) => string | undefined;`
- At every in-adapter site that calls `getClaudeModelCapabilities(...)` (grep the file; the main one is ~4255, and check the prompt-build path around ~1420 that gates ultrathink prompt injection), use `options?.getModelCapabilities?.(model) ?? getClaudeModelCapabilities(model)`.
- In `getEffectiveClaudeAgentEffort` (or at its call sites), use `options?.normalizeEffort ?? normalizeClaudeCliEffort`. Keep default behavior bit-identical for all existing drivers (Claude, Synthero) — the new options are opt-in.
- Do not change `resolveClaudeApiModelId` or anything else.

### 3. Tests — update `apps/server/src/provider/Drivers/ClaudexDriver.test.ts`
- Replace the now-wrong test "does not expose or resolve effort for Claudex model slugs" with:
  - both CLAUDEX_MODELS expose exactly one option descriptor: effort select with the five values; defaults: luna=max, sol=high; no `promptInjectedValues`.
  - `getClaudexModelCapabilities("claudex-sol")` returns those caps; unknown slug → undefined.
  - `resolveClaudeEffort(getClaudexModelCapabilities("claudex-luna"), "xhigh")` (import from ClaudeProvider) === "xhigh", and with rawEffort undefined resolves to the default ("max" for luna) — verify actual resolveClaudeEffort default semantics first and assert accordingly.
  - `normalizeClaudexEffort`: passes all five through; undefined/"ultrathink"/"ultracode"/garbage → undefined. Contrast pin: `normalizeClaudeCliEffort("xhigh", "claudex-luna")` returns "max" (documents WHY the bypass exists).
  - `normalizeClaudexModelSelection` preserves `options` (selection with `options: [{id:"effort", value:"xhigh"}]` keeps them through coercion).
- Keep snapshot-normalization test but update the empty-descriptors assertion: descriptors now contain exactly the effort select (assert ids === ["effort"], and NOT thinking/reasoningEffort).
- If ClaudeAdapter has its own test file covering options, add coverage that the new options default to existing behavior when omitted (only if a test harness for the adapter already exists — do not build new adapter integration scaffolding).

### 4. Out of scope
- No mac app changes ("effort" is already in mac's `effortOptionIDs`; picker appears automatically once the server sends the descriptor).
- No cliproxyapi config changes.
- No changes to vanilla Claude/Synthero driver behavior — verify by running their test suites.
- Do not remove the model-list pinning, continuation key, settings, or registration from PR #81.

## Verification (run all; repo root is a pnpm monorepo, tests via `vp test run` in apps/server)
- `apps/server`: `vp test run src/provider/Drivers/ClaudexDriver.test.ts src/provider/Drivers/ClaudeSyntheroDriver.test.ts src/provider/Layers/FuguProvider.test.ts src/provider/Layers/CodexProvider.test.ts src/provider/Layers/ProviderInstanceRegistryLive.test.ts` plus any ClaudeAdapter/ClaudeProvider test files (grep for them) — all green.
- `pnpm typecheck` in apps/server and packages/contracts (if contracts touched; ideally it isn't).
- `vp lint --report-unused-disable-directives` on every touched file — zero errors. Note: `Effect.runSync` is banned in tests; use the `it.layer(NodeServices.layer)` + `it.effect` pattern from ClaudeHome.test.ts if any Effect-running test is needed.
- Do NOT commit; leave the working tree dirty for review.

## Style
Match surrounding Effect-TS idiom; sparse comments; the adapter option threading should read like the existing optional options (nativeEventLogger etc.).
