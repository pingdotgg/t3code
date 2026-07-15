# Phase 1 Implementation Task

You are implementing Phase 1 of the unified cross-provider sub-agent system for SergeCode.

## Context
Read the plan at `.plans/unified-subagent-system.md` to understand the full architecture.

## Your Task: Phase 1 - Provider Registry Enhancement

Create the SubAgentProviderRegistry service that:

1. Extends the existing ProviderRegistry to add sub-agent-specific capabilities
2. Implements per-model concurrency limits (cheap models: 20-30, expensive: 3-5)
3. Automatically excludes OpenCode (API credits provider)
4. Provides provider discovery and validation

## Files to Create

### 1. `apps/server/src/subagent/SubAgentProviderRegistry.ts`
Main service implementation using Effect layers. Integrates with existing ProviderRegistry.

### 2. `apps/server/src/subagent/SubAgentProviderInfo.ts`
Schema definitions using effect/Schema. Include:
- SubAgentProviderInfo interface with model cost tiers
- SubAgentProviderFilter for filtering
- Model cost tier classification helpers

### 3. `apps/server/src/subagent/ConcurrencyLimits.ts`
Concurrency limit management:
- Per-model tracking
- Global ceiling enforcement
- Rate limit checking

### 4. `apps/server/src/subagent/SubAgentError.ts`
Error types for sub-agent operations extending existing error patterns.

## Key Requirements

### Model Cost Tiers
```typescript
const MODEL_COST_TIERS: Record<string, 'cheap' | 'moderate' | 'expensive'> = {
  // Cheap (limit: 30)
  'claude-haiku-4.5': 'cheap',
  'gpt-4o-mini': 'cheap',
  
  // Moderate (limit: 10)
  'claude-sonnet-5': 'moderate',
  'gpt-4o': 'moderate',
  
  // Expensive (limit: 5)
  'claude-fable-5': 'expensive',
  'claude-opus-4.8': 'expensive',
  'gpt-5.5': 'expensive',
};

const CONCURRENCY_LIMITS = {
  cheap: 30,
  moderate: 10,
  expensive: 5,
  global: 50,
};
```

### OpenCode Exclusion
Mark opencode driver as `costTier: 'api-credits'` and never return as spawnable.

## Reference Files to Study First
- `apps/server/src/provider/Services/ProviderRegistry.ts`
- `apps/server/src/provider/builtInProviderCatalog.ts`
- `apps/server/src/mcp/toolkits/agents/SubAgentCoordinator.ts`
- `packages/contracts/src/providerInstance.ts`

## Implementation Steps

1. Read all reference files to understand patterns
2. Create SubAgentProviderInfo.ts with schemas
3. Create SubAgentError.ts with error types
4. Create ConcurrencyLimits.ts with tracking
5. Create SubAgentProviderRegistry.ts with main logic
6. Create tests in `apps/server/src/subagent/__tests__/`
7. Run `vp check` and `vp run typecheck`

## Success Criteria
- All 4 TypeScript files created with full implementations
- Comprehensive test suite passes
- TypeScript type checking passes
- OpenCode never listed as spawnable
- Concurrency limits enforced per-model and globally
