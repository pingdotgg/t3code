# Add GPT 5.6 Model Support and Fast Mode Toggle

## Objective
Update SergeCode to support new GPT 5.6 models (sol/luna/terra variants) with all reasoning modes (up to ultra), and ensure fast mode toggle works for Codex/GPT models.

## Context
- GPT models are managed through Codex CLI
- Model capabilities are fetched dynamically from `codex app-server model/list`
- Model aliases are defined in `packages/contracts/src/model.ts`
- Reasoning effort and service tier (fast mode) are already implemented as option descriptors
- Fast mode maps to `serviceTier: "fast"` with legacy `fastMode` boolean support

## Tasks

### 1. Add GPT 5.6 Model Aliases
**File**: `packages/contracts/src/model.ts`

Add new model aliases to `MODEL_SLUG_ALIASES_BY_PROVIDER[CODEX_DRIVER_KIND]`:
```typescript
[CODEX_DRIVER_KIND]: {
  "gpt-5-codex": "gpt-5.4",
  "5.4": "gpt-5.4",
  "5.3": "gpt-5.3-codex",
  "gpt-5.3": "gpt-5.3-codex",
  "5.3-spark": "gpt-5.3-codex-spark",
  "gpt-5.3-spark": "gpt-5.3-codex-spark",
  // NEW: GPT 5.6 variants
  "5.6": "gpt-5.6",
  "gpt-5.6": "gpt-5.6",
  "5.6-sol": "gpt-5.6-sol",
  "gpt-5.6-sol": "gpt-5.6-sol",
  "sol": "gpt-5.6-sol",
  "5.6-luna": "gpt-5.6-luna",
  "gpt-5.6-luna": "gpt-5.6-luna",
  "luna": "gpt-5.6-luna",
  "5.6-terra": "gpt-5.6-terra",
  "gpt-5.6-terra": "gpt-5.6-terra",
  "terra": "gpt-5.6-terra",
},
```

### 2. Add Ultra Reasoning Mode Label
**File**: `apps/server/src/provider/Layers/CodexProvider.ts`

Update `REASONING_EFFORT_LABELS` to include ultra and any new reasoning modes:
```typescript
const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra", // NEW
};
```

### 3. Verify Fast Mode Service Tier Mapping
**File**: `apps/server/src/codexModelOptions.ts`

Current implementation already handles fast mode correctly:
```typescript
export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "serviceTier") ??
    (getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true ? "fast" : undefined)
  );
}
```

No changes needed - already supports both `serviceTier` and legacy `fastMode`.

### 4. Update Default Model (Optional)
**File**: `packages/contracts/src/model.ts`

Consider updating default model to GPT 5.6 if appropriate:
```typescript
export const DEFAULT_MODEL = "gpt-5.6"; // or keep "gpt-5.4"
```

Decision: Keep as "gpt-5.4" for now unless user specifies otherwise.

## Testing Requirements

1. **Model aliases resolve correctly**
   - Test that "sol", "luna", "terra" resolve to full model names
   - Test that "5.6" resolves correctly

2. **Reasoning modes display properly**
   - Verify ultra reasoning mode shows "Ultra" label
   - Verify all reasoning modes work with new models

3. **Fast mode toggle works**
   - Verify serviceTier option appears for GPT models
   - Verify selecting "Fast" service tier works
   - Verify backward compatibility with legacy fastMode boolean

4. **Integration with Codex CLI**
   - Verify models appear in model picker when codex supports them
   - Verify capabilities are read correctly from codex

## Implementation Notes

- The actual model list comes from Codex CLI, so GPT 5.6 models will only appear if the user's Codex installation supports them
- Model aliases allow users to type shorthand like "sol" or "luna" instead of full model names
- Service tier (fast mode) is already implemented and working - just needs to be visible in UI
- Reasoning effort options are dynamically generated from what Codex reports for each model

## Dependencies

- Requires Codex CLI version that supports GPT 5.6 models
- No breaking changes to existing functionality
