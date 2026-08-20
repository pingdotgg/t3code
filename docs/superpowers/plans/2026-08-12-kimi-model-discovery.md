# Kimi Model Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate Kimi models and model-specific thinking controls from the generic ACP config-option response used by Kimi Code CLI 0.29.1.

**Architecture:** Normalize the model catalog inside `KimiProvider` at the ACP adapter boundary. Prefer the generic `model` select config option, fall back to legacy ACP model state, then reuse the existing bounded per-model capability probe and provider snapshot pipeline.

**Tech Stack:** TypeScript, Effect, effect-acp schemas, Vite Plus/Vitest

## Global Constraints

- Kimi's official `K2.7 Coding Highspeed` entry is a model, not a synthetic speed toggle.
- Do not hard-code the managed Kimi model catalog in production code.
- Preserve older ACP implementations that return `models.availableModels`.
- Do not change contracts, web, mobile, orchestration, or shared ACP runtime behavior.
- Use only focused tests and the targeted server typecheck.
- Run every JavaScript or TypeScript repository command from a fresh login shell where
  `node --version` satisfies `package.json`'s `^24.13.1` requirement. The implementation shell was
  verified with Node `v24.14.0`; do not copy a machine-specific Node path into repository commands.

## Provider Adapter Decisions

| Provider | Decision                                   | Verification                                                 |
| -------- | ------------------------------------------ | ------------------------------------------------------------ |
| Kimi     | Update generic ACP model-option discovery. | Focused Kimi provider fixture and live ACP probe.            |
| Codex    | Unchanged.                                 | Final diff check confirms no Codex adapter files changed.    |
| Claude   | Unchanged.                                 | Final diff check confirms no Claude adapter files changed.   |
| Cursor   | Unchanged.                                 | Final diff check confirms no Cursor adapter files changed.   |
| Grok     | Unchanged.                                 | Final diff check confirms no Grok adapter files changed.     |
| OpenCode | Unchanged.                                 | Final diff check confirms no OpenCode adapter files changed. |

---

### Task 1: Normalize modern and legacy Kimi model discovery

**Files:**

- Modify: `apps/server/src/provider/Layers/KimiProvider.test.ts:25-275`
- Modify: `apps/server/src/provider/Layers/KimiProvider.ts:52-285`

**Interfaces:**

- Consumes: `EffectAcpSchema.NewSessionResponse | LoadSessionResponse | ResumeSessionResponse`
- Produces: normalized `{ currentModelId, availableModels }` values used by the existing `KimiAcpDiscovery`
- Preserves: `kimiModelCapabilitiesFromConfigOptions` and `applyKimiAcpModelSelection` option IDs

- [ ] **Step 1: Make the deterministic fixture match Kimi Code CLI 0.29.1**

Remove the legacy `models` object from the fixture's `session/new` response. Advertise the model
catalog through the real generic select shape and return model-specific thinking values:

```ts
const modelOptions = [
  { value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
  {
    value: "kimi-code/kimi-for-coding-highspeed",
    name: "K2.7 Coding Highspeed",
  },
  { value: "kimi-code/k3", name: "K3" },
  { value: "kimi-code/k3-256k", name: "K3-256k" },
];

const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: currentModel,
    options: modelOptions,
  },
  currentModel === "kimi-code/k3" || currentModel === "kimi-code/k3-256k"
    ? {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
          { value: "max", name: "Max" },
        ],
      }
    : {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "on",
        options: [{ value: "on", name: "On" }],
      },
  // Existing mode option remains unchanged.
];
```

Change the ready-state assertion to expect all four literal model IDs, the first model as default,
Highspeed as a normal model, and K3's literal `Low | High | Max` capability descriptor with `High`
marked default.

The production mutation caught by this test is: reading only `sessionSetupResult.models` returns an
empty provider model list for the current Kimi CLI.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --version # Must satisfy ^24.13.1 before running pnpm.
pnpm exec vp test run apps/server/src/provider/Layers/KimiProvider.test.ts
```

Expected: the ready-state assertion fails because the provider snapshot contains no discovered
models (or only explicitly configured custom models).

- [ ] **Step 3: Add pure normalization coverage for malformed and legacy inputs**

Export a narrow helper named `kimiModelStateFromSessionSetup` and add two direct assertions:

```ts
expect(
  kimiModelStateFromSessionSetup({
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "kimi-code/k3",
        options: [
          { value: "", name: "Blank" },
          { value: "kimi-code/k3", name: "K3" },
          { value: "kimi-code/k3", name: "Duplicate" },
        ],
      },
    ],
  }),
).toEqual({
  currentModelId: "kimi-code/k3",
  availableModels: [{ modelId: "kimi-code/k3", name: "K3" }],
});
```

The legacy assertion passes a setup object with `models.currentModelId` and
`models.availableModels` but no model config option, and expects those values unchanged. These tests
catch incorrect precedence, blank entries, duplicate entries, and accidental removal of backwards
compatibility.

- [ ] **Step 4: Run the focused test and confirm both new assertions are RED**

Run the same focused command. Expected: the helper import/export is missing before production code
is written.

- [ ] **Step 5: Implement the minimal normalizer and use it in discovery**

Add a setup-response structural input type and this behavior in `KimiProvider.ts`:

```ts
export function kimiModelStateFromSessionSetup(setup: {
  readonly models?: EffectAcpSchema.SessionModelState | null;
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
}): Pick<KimiAcpDiscovery, "currentModelId" | "availableModels"> {
  const modelOption = setup.configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );
  if (modelOption) {
    const seen = new Set<string>();
    const availableModels = collectSessionConfigOptionValuesWithNames(modelOption).flatMap(
      ({ value, name }) => {
        const modelId = value.trim();
        if (!modelId || seen.has(modelId)) return [];
        seen.add(modelId);
        return [{ modelId, name: name.trim() || modelId }];
      },
    );
    if (availableModels.length > 0) {
      return {
        currentModelId: modelOption.currentValue?.trim() || undefined,
        availableModels,
      };
    }
  }
  return {
    currentModelId: setup.models?.currentModelId?.trim() || undefined,
    availableModels: setup.models?.availableModels ?? [],
  };
}
```

Implement the flattening locally using the same grouped/ungrouped select-option traversal already
used by `kimiModelCapabilitiesFromConfigOptions`; do not add a shared abstraction. In
`discoverKimiViaAcp`, obtain `initialConfigOptions` first, normalize from both setup sources, and
then run the existing per-model capability loop.

- [ ] **Step 6: Run focused GREEN verification**

Run:

```powershell
node --version # Must satisfy ^24.13.1 before running pnpm.
pnpm exec vp test run apps/server/src/provider/Layers/KimiProvider.test.ts
```

Expected: all Kimi provider tests pass, including modern ACP discovery, K3 thinking levels,
deduplication, and legacy fallback.

- [ ] **Step 7: Run the real installed-CLI non-billing probe**

Run:

```powershell
node --version # Must satisfy ^24.13.1 before running pnpm.
$env:T3_KIMI_ACP_PROBE='1'
pnpm exec vp test run apps/server/src/provider/acp/KimiAcpCliProbe.test.ts
Remove-Item Env:T3_KIMI_ACP_PROBE
```

Expected: the installed Kimi CLI initializes, authenticates, and creates a throwaway ACP session
without sending a prompt.

- [ ] **Step 8: Run targeted typecheck and diff review**

Run:

```powershell
node --version # Must satisfy ^24.13.1 before running pnpm.
pnpm exec vp run --filter t3 typecheck
git diff --check
git diff -- apps/server/src/provider/Layers/KimiProvider.ts apps/server/src/provider/Layers/KimiProvider.test.ts
```

Expected: typecheck exits zero, no whitespace errors, and the diff remains confined to discovery
and its focused coverage.

- [ ] **Step 9: Commit the implementation**

```powershell
git add apps/server/src/provider/Layers/KimiProvider.ts apps/server/src/provider/Layers/KimiProvider.test.ts
git commit -m "fix(provider): discover current Kimi models"
```

---

### Task 2: Verify the complete branch before publication

**Files:**

- Verify: `docs/superpowers/specs/2026-08-12-kimi-model-discovery-design.md`
- Verify: `docs/superpowers/plans/2026-08-12-kimi-model-discovery.md`
- Verify: `apps/server/src/provider/Layers/KimiProvider.ts`
- Verify: `apps/server/src/provider/Layers/KimiProvider.test.ts`

**Interfaces:**

- Consumes: completed Task 1 branch
- Produces: a reviewable, focused branch ready for a non-draft pull request

- [ ] **Step 1: Run final focused verification from a clean command**

```powershell
node --version # Must satisfy ^24.13.1 before running pnpm.
pnpm exec vp test run apps/server/src/provider/Layers/KimiProvider.test.ts apps/server/src/provider/acp/KimiAcpCliProbe.test.ts
pnpm exec vp run --filter t3 typecheck
git diff --check fork/main...HEAD
git diff --exit-code fork/main...HEAD -- apps/server/src/provider/Layers/CodexProvider.ts apps/server/src/provider/Layers/ClaudeProvider.ts apps/server/src/provider/Layers/CursorProvider.ts apps/server/src/provider/Layers/GrokProvider.ts apps/server/src/provider/Layers/OpenCodeProvider.ts
git status --short
```

Expected: deterministic tests pass; the opt-in live probe remains skipped unless its environment
flag is set; typecheck exits zero; branch contains only the approved spec, plan, implementation, and
tests.

- [ ] **Step 2: Confirm the branch commits and file scope**

```powershell
git log --oneline fork/main..HEAD
git diff --stat fork/main...HEAD
```

Expected: the branch contains the design, plan, focused implementation, and tests only. It is then
ready for the repository's PR publication and review-babysitting workflow.
