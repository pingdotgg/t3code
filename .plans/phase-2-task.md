# Phase 2 Implementation Task

You are implementing Phase 2 of the unified cross-provider sub-agent system for SergeCode.

## Context
Read the plan at `.plans/unified-subagent-system.md` to understand the full architecture.

## Your Task: Phase 2 - Unified Sub-Agent Tool

Create the UnifiedSubAgentTool that all providers can use without MCP capability gates.

## Files to Create

### 1. `apps/server/src/subagent/UnifiedSubAgentTool.ts`
Single tool using effect/unstable/ai Toolkit with actions:
- `list`: List available providers and spawned sub-agents
- `spawn`: Spawn a new sub-agent on any provider
- `send`: Send follow-up prompt to existing sub-agent
- `wait`: Wait for sub-agent turn completion

No MCP capability requirements - universally available.

### 2. `packages/contracts/src/subagent.ts`
Enhanced schemas for UnifiedSubAgent operations. Extend existing SubAgent types if they exist.

### 3. Integration with existing `SubAgentCoordinator`
Enhance `apps/server/src/mcp/toolkits/agents/SubAgentCoordinator.ts` to:
- Work without MCP gates for UnifiedSubAgent calls
- Keep backward compatibility with MCP agent_* tools
- Share core spawning logic

## Tool Interface

```typescript
const UnifiedSubAgentTool = Tool.make("subagent", {
  description: `Spawn and manage sub-agents across any configured provider.
  
Actions:
- 'list': Discover available providers (with models/capabilities) and see spawned sub-agents
- 'spawn': Create a sub-agent on any provider, including different ones from yourself (e.g., Claude can spawn Codex)
- 'send': Send follow-up prompt to existing sub-agent
- 'wait': Wait for sub-agent turn to complete and get result

Use 'list' first to see available providers. OpenCode is excluded (uses API credits).`,
  
  parameters: Schema.Struct({
    action: Schema.Literals(["list", "spawn", "send", "wait"]),
    
    // For spawn
    provider: Schema.optional(ProviderInstanceId),
    model: Schema.optional(TrimmedNonEmptyString),
    prompt: Schema.optional(TrimmedNonEmptyString),
    name: Schema.optional(TrimmedNonEmptyString),
    title: Schema.optional(TrimmedNonEmptyString),
    
    // For send/wait
    threadId: Schema.optional(ThreadId),
    timeoutSeconds: Schema.optional(Schema.Int),
  }),
  
  success: UnifiedSubAgentResult,
  failure: SubAgentError,
});
```

## Key Requirements

1. **Universal Access**: No MCP capability checks
2. **Provider Discovery**: Built-in via SubAgentProviderRegistry (from Phase 1)
3. **Validation**: Check spawnable status, concurrency limits
4. **Error Messages**: Clear, actionable (e.g., "Provider X unavailable, try Y instead")
5. **Backward Compat**: Existing agent_* MCP tools continue working

## Integration Points

- Uses `SubAgentProviderRegistry` from Phase 1 (if available, mock if not)
- Reuses core logic from existing `SubAgentCoordinator`
- Follows Effect patterns from codebase

## Reference Files to Study

- `apps/server/src/mcp/toolkits/agents/tools.ts` (existing agent tools)
- `apps/server/src/mcp/toolkits/agents/handlers.ts` (handler patterns)
- `apps/server/src/mcp/toolkits/agents/SubAgentCoordinator.ts` (core logic)
- `packages/contracts/src/subagent.ts` (schemas - may not exist yet)

## Implementation Steps

1. Study reference files
2. Create/enhance `packages/contracts/src/subagent.ts` with schemas
3. Create `UnifiedSubAgentTool.ts` with tool definition
4. Add handler logic that routes to SubAgentCoordinator
5. Create tests in `apps/server/src/subagent/__tests__/UnifiedSubAgentTool.test.ts`
6. Run `vp check` and `vp run typecheck`

## Success Criteria

- UnifiedSubAgentTool fully implemented
- Works without MCP gates
- Can list providers with accurate info
- Can spawn cross-provider sub-agents
- Tests pass
- Type checking passes
- Clear error messages for common failures
