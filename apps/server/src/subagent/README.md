# Unified Sub-Agent System

Cross-provider sub-agent orchestration for SergeCode. Any provider (Claude, Codex, Grok, Fugu, Cursor) can spawn agents on any other provider.

## Architecture

### Core Components

1. **UniversalSubAgentCoordinator** - Provider-agnostic coordinator
   - Similar to MCP-based `SubAgentCoordinator` but without capability gates
   - Takes simple context (threadId, providerInstanceId, environmentId)
   - Delegates to `SubAgentCoordinator` with properly-formed MCP scopes

2. **UnifiedSubAgentTool** - Universal tool available to all providers
   - Single tool with actions: list, spawn, send, wait, workflow
   - No MCP capability checks required
   - Registered with all provider adapters

3. **SubAgentProviderRegistry** - Tracks all available providers
   - Lists spawnable providers (excludes OpenCode - API credits)
   - Maps provider instances to models and capabilities
   - Classifies providers by cost tier (free/subscription/api-credits)

4. **ConcurrencyLimits** - Per-model concurrency management
   - Cheap models (haiku, gpt-4o-mini): 30 concurrent
   - Moderate models (sonnet, gpt-4o): 10 concurrent
   - Expensive models (fable, opus, gpt-5.5): 5 concurrent
   - Global max: 50 total sub-agents

5. **WorkflowEngine** - Multi-agent orchestration
   - JSON-based workflow definitions
   - Sequential, parallel, and pipeline execution modes
   - Built-in workflows: code-review, parallel-search, multi-model-eval

## Usage

### From a Provider Adapter

```typescript
import { createUnifiedSubAgentToolHandler } from '../subagent/integration.ts';

// In your adapter's session initialization:
const handler = createUnifiedSubAgentToolHandler({
  threadId: currentThreadId,
  providerInstanceId: currentProviderInstanceId,
  environmentId: currentEnvironmentId, // Required!
});

// Execute tool calls:
const result = yield* handler({
  action: 'spawn',
  providerInstanceId: 'grok-default',
  model: 'grok-4.5',
  prompt: 'Analyze this code'
});
```

### From AI Models

The UnifiedSubAgentTool appears as `subagent` in the tool list:

```json
{
  "tool": "subagent",
  "input": {
    "action": "list"
  }
}
```

Then spawn on any provider:

```json
{
  "tool": "subagent",
  "input": {
    "action": "spawn",
    "providerInstanceId": "grok-default",
    "model": "grok-4.5",
    "prompt": "Review this code for security issues"
  }
}
```

Wait for completion:

```json
{
  "tool": "subagent",
  "input": {
    "action": "wait",
    "threadId": "<threadId from spawn>"
  }
}
```

## Provider Integration

To add UnifiedSubAgentTool to a provider adapter:

1. Add the tool to your Effect layer stack
2. Ensure `environmentId` is available in your session context
3. The tool will automatically have access to all providers

## Model Cost Tiers

Models are classified by cost to enforce appropriate concurrency limits:

**Cheap (30 concurrent):**
- claude-haiku-4.5, claude-haiku-4
- gpt-4o-mini, gpt-4-turbo

**Moderate (10 concurrent):**
- claude-sonnet-5, claude-sonnet-4
- gpt-4o, gpt-4

**Expensive (5 concurrent):**
- claude-fable-5, claude-opus-4.8, claude-opus-4
- gpt-5.5, gpt-5

## Provider Cost Tiers

**Subscription (spawnable):**
- codex, claudeAgent, claudeSynthero, claudex
- cursor, grok, fugu, chatgpt

**API Credits (excluded):**
- opencode - Automatically excluded to protect API credits

## Differences from MCP-based SubAgentCoordinator

| Feature | MCP SubAgentCoordinator | UniversalSubAgentCoordinator |
|---------|------------------------|------------------------------|
| Capability check | Required ("agents") | None - universally available |
| Scope type | McpInvocationScope (7 fields) | UniversalSubAgentContext (3 fields) |
| Provider access | Only MCP-gated providers | All configured providers |
| Tool name | agent_list, agent_spawn, etc. | subagent (single tool) |
| Concurrency management | Basic | Per-model tier limits |
| OpenCode handling | Manual check | Auto-excluded |

## Workflow System

Built-in workflows for common multi-agent patterns:

- **code-review**: Multi-dimensional code review with verification
- **parallel-search**: Fan-out search across multiple agents
- **multi-model-eval**: Compare answers from different models

Custom workflows can be defined in JSON and stored in the workflow directory.

## Architecture Decision: Why Not Reuse SubAgentCoordinator?

The original PR #131 tried to reuse `SubAgentCoordinator` by creating "mock" MCP scopes:

```typescript
// BROKEN approach from PR #131
const mockScope = {
  threadId, providerInstanceId,
  capabilities: new Set(["agents"])
} as any; // Missing 4 required fields!
```

This broke because `McpInvocationScope` requires 7 fields, not 3. The fix creates a proper scope:

```typescript
// FIXED approach
const createMcpScope = (context: UniversalSubAgentContext) => {
  const now = Date.now();
  return {
    environmentId: context.environmentId,
    threadId: context.threadId,
    providerSessionId: `universal-subagent-${context.threadId}`,
    providerInstanceId: context.providerInstanceId,
    capabilities: new Set(["agents"]),
    issuedAt: now,
    expiresAt: now + 3600000, // 1 hour
  };
};
```

Now `UniversalSubAgentCoordinator` delegates to `SubAgentCoordinator` with properly-formed scopes, avoiding code duplication while fixing the type safety issue.

## Testing

Run the test suite:

```bash
npm test apps/server/src/subagent
```

Tests cover:
- ConcurrencyLimits enforcement
- SubAgentProviderInfo classification
- WorkflowSchema validation
- WorkflowEngine execution
- BuiltinWorkflows loading
- Integration scenarios
