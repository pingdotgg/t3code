# Unified Sub-Agent System Restoration Plan

## Problem Analysis

### What Broke in PR #131

1. **Incomplete McpInvocationScope mocking**: The `UnifiedSubAgentHandlers` created mock scopes with only 3 fields:
   ```typescript
   const mockScope = {
     threadId: context.threadId,
     providerInstanceId: context.providerInstanceId,
     capabilities: new Set(["agents"]),
   };
   ```
   But `McpInvocationScope` requires 7 fields:
   - `environmentId` ❌ missing
   - `providerSessionId` ❌ missing
   - `issuedAt` ❌ missing
   - `expiresAt` ❌ missing

2. **Type safety bypassed with `as any`**: Used `mockScope as any` to force compatibility, hiding the type errors until runtime

3. **Potential Effect layer integration issues**: The unified system added new Effect services but may not have properly wired them into the application's layer stack

4. **CodexAdapter integration incomplete**: Only added import for `mapCodexCollabAgentToUnified` but didn't actually use it

### What PR #131 Was Supposed to Do

Create a **unified caller-facing cross-provider sub-agent system** where:
- ANY provider (Claude, Codex, Grok, Fugu, Cursor) can spawn agents on ANY other provider
- Single `UnifiedSubAgentTool` that safely delegates through the existing MCP coordinator
- Provider registry that tracks all available providers and their models
- Concurrency management per model cost tier (cheap: 30, moderate: 10, expensive: 5)
- Workflow engine for multi-agent orchestration
- Automatic exclusion of OpenCode (API credits protection)

## Root Cause

The system tried to reuse the MCP-based `SubAgentCoordinator` with incomplete fake scopes. Reuse is the right architecture, but the scope construction was unsafe because:

1. SubAgentCoordinator is designed for MCP-gated access
2. The unified entry point must preserve internal capability enforcement
3. Creating incomplete scopes breaks the security/capability model
4. Type safety violations cause runtime failures

## Solution Architecture

### Approach: Safe Delegation Through the Existing Coordinator

Create a provider-neutral wrapper that accepts a smaller caller context and delegates through the existing coordinator using a complete MCP invocation scope:

1. **UniversalSubAgentCoordinator** (new)
   - Takes a simple context (threadId, providerInstanceId, environmentId)
   - Constructs all required MCP scope fields
   - Delegates list/spawn/send/wait to `SubAgentCoordinator`
   - Preserves the `agents` capability internally

2. **Keep existing SubAgentCoordinator as the execution authority**
   - Continues serving the existing MCP agent tools
   - Remains the single source of truth for child lifecycle state
   - Preserves capability enforcement and backward compatibility

3. **UnifiedSubAgentTool** uses `UniversalSubAgentCoordinator`
   - No fake or partial scopes
   - Clean type safety at the wrapper boundary
   - Provider-neutral caller-facing API

## Implementation Plan

### Phase 1: Restore Core Files (No Integration Yet)

Restore from commit 5d8d1dadb but with fixes:

1. **SubAgentProviderInfo.ts** ✓ (no changes needed)
2. **SubAgentProviderRegistry.ts** ✓ (no changes needed)
3. **ConcurrencyLimits.ts** ✓ (no changes needed)
4. **SubAgentError.ts** ✓ (no changes needed)
5. **WorkflowSchema.ts** ✓ (no changes needed)
6. **WorkflowStorage.ts** ✓ (no changes needed)
7. **WorkflowEngine.ts** ✓ (no changes needed)
8. **BuiltinWorkflows.ts** ✓ (no changes needed)

### Phase 2: Create UniversalSubAgentCoordinator

**NEW FILE**: `apps/server/src/subagent/UniversalSubAgentCoordinator.ts`

```typescript
/**
 * UniversalSubAgentCoordinator - Cross-provider sub-agent orchestration
 * without MCP capability gates.
 * 
 * Unlike SubAgentCoordinator (MCP-based), this is universally available
 * to all providers without capability checks.
 */

interface UniversalSubAgentContext {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly environmentId: EnvironmentId;
}

export class UniversalSubAgentCoordinator {
  // Similar methods to SubAgentCoordinator but with simpler context
  readonly list: (context: UniversalSubAgentContext) => Effect<SubAgentListResult>
  readonly spawn: (context: UniversalSubAgentContext, input: SubAgentSpawnInput) => Effect<SubAgentSpawnResult>
  readonly send: (context: UniversalSubAgentContext, input: SubAgentSendInput) => Effect<SubAgentSendResult>
  readonly wait: (context: UniversalSubAgentContext, input: SubAgentWaitInput) => Effect<SubAgentWaitResult>
}
```

**Key Difference**:
- Callers supply `UniversalSubAgentContext`
- The wrapper creates a complete `McpInvocationScope`
- `SubAgentCoordinator` remains the single execution and child-tracking authority

### Phase 3: Fix UnifiedSubAgentHandlers

**FIXED**: `apps/server/src/subagent/UnifiedSubAgentHandlers.ts`

Change from:
```typescript
const mockScope = { ... } as any; // BAD
yield* coordinator.spawn(mockScope, input); // SubAgentCoordinator
```

To:
```typescript
const context = {
  threadId: context.threadId,
  providerInstanceId: context.providerInstanceId,
  environmentId: context.environmentId, // Must be provided by caller
};
yield* universalCoordinator.spawn(context, input); // UniversalSubAgentCoordinator
```

### Phase 4: Update UnifiedSubAgentTool

**FIXED**: `apps/server/src/subagent/UnifiedSubAgentTool.ts`

Update dependencies:
```typescript
dependencies: [
  SubAgentProviderRegistry,
  ConcurrencyLimits,
  UniversalSubAgentCoordinator, // Not SubAgentCoordinator
  WorkflowEngine,
  WorkflowStorage,
]
```

### Phase 5: Integration Layer

**FIXED**: `apps/server/src/subagent/integration.ts`

Update `createUnifiedSubAgentToolHandler` to require `environmentId`:
```typescript
export const createUnifiedSubAgentToolHandler = (context: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly environmentId: EnvironmentId; // NEW - required
}) => { ... }
```

### Phase 6: Wire Into Provider Adapters

Each adapter needs to expose the UnifiedSubAgentTool. Check:

1. **ClaudeAdapter** - Add UnifiedSubAgentTool to toolkit
2. **CodexAdapter** - Add UnifiedSubAgentTool to toolkit  
3. **GrokAdapter** - Add UnifiedSubAgentTool to toolkit
4. **CursorAdapter** - Add UnifiedSubAgentTool to toolkit
5. **FuguAdapter** - Add UnifiedSubAgentTool to toolkit (if exists)

Pattern:
```typescript
import { UnifiedSubAgentTool } from '../../subagent/UnifiedSubAgentTool.ts';

// In adapter session initialization:
const toolkitWithSubAgents = Toolkit.make(
  ...existingTools,
  UnifiedSubAgentTool,
);
```

### Phase 7: Layer Wiring

Add to main server layer stack:
```typescript
// In server startup/layer composition
Layer.mergeAll(
  SubAgentProviderRegistryLive,
  ConcurrencyLimitsLive,
  UniversalSubAgentCoordinatorLive,
  WorkflowEngineLive,
  WorkflowStorageLive,
  // ... other layers
)
```

### Phase 8: Testing Strategy

1. **Unit tests**: All test files from PR #131 should pass
2. **Integration test**: Spawn agent from Claude → Grok
3. **Integration test**: Spawn agent from Codex → Claude
4. **Concurrency test**: Verify limits enforced
5. **OpenCode exclusion test**: Verify OpenCode not spawnable

## Files to Restore/Create

### Restore from PR #131 (8 files)
- `apps/server/src/subagent/SubAgentProviderInfo.ts`
- `apps/server/src/subagent/SubAgentProviderRegistry.ts`
- `apps/server/src/subagent/ConcurrencyLimits.ts`
- `apps/server/src/subagent/SubAgentError.ts`
- `apps/server/src/subagent/workflows/WorkflowSchema.ts`
- `apps/server/src/subagent/workflows/WorkflowStorage.ts`
- `apps/server/src/subagent/workflows/WorkflowEngine.ts`
- `apps/server/src/subagent/workflows/BuiltinWorkflows.ts`

### Create New (1 file)
- `apps/server/src/subagent/UniversalSubAgentCoordinator.ts`

### Fix from PR #131 (3 files)
- `apps/server/src/subagent/UnifiedSubAgentHandlers.ts` (use UniversalSubAgentCoordinator)
- `apps/server/src/subagent/UnifiedSubAgentTool.ts` (update dependencies)
- `apps/server/src/subagent/integration.ts` (require environmentId)

### Restore Tests (7 files)
- `apps/server/src/subagent/__tests__/ConcurrencyLimits.test.ts`
- `apps/server/src/subagent/__tests__/SubAgentProviderInfo.test.ts`
- `apps/server/src/subagent/__tests__/WorkflowSchema.test.ts`
- `apps/server/src/subagent/__tests__/WorkflowEngine.test.ts`
- `apps/server/src/subagent/__tests__/BuiltinWorkflows.test.ts`
- `apps/server/src/subagent/__tests__/integration.test.ts`

### Restore Workflow Definitions (3 files)
- `apps/server/src/subagent/workflows/builtins/code-review.json`
- `apps/server/src/subagent/workflows/builtins/parallel-search.json`
- `apps/server/src/subagent/workflows/builtins/multi-model-eval.json`

## Risk Mitigation

1. **Keep MCP SubAgentCoordinator authoritative** - No duplicate child lifecycle state
2. **Use a narrow wrapper** - The unified entry point delegates instead of reimplementing orchestration
3. **Type-safe from the start** - No `as any` bypasses
4. **Incremental integration** - Can test each adapter separately
5. **Feature flag ready** - Easy to disable if issues arise

## Success Criteria

✅ App starts successfully (no startup errors)
✅ Claude (fable-5) can spawn Grok (grok-4.5) agents
✅ Codex can spawn Claude agents
✅ Grok can spawn Fugu agents (if Fugu adapter exists)
✅ Concurrency limits enforced per model tier
✅ OpenCode excluded from spawnable providers
✅ All tests pass
✅ Type safety maintained (no `as any`)

## Expected Outcome

When complete, you (fable-5) will be able to:
```typescript
// List all providers and their models
agent_list() // or use UnifiedSubAgentTool with action='list'

// Spawn on any provider
agent_spawn({
  providerInstanceId: "grok-default",
  model: "grok-4.5", 
  prompt: "Analyze this code for security issues"
})

// True cross-provider orchestration
```

And the system will route directly to the Grok provider, no intermediaries, no codex proxy.
