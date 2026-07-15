# Unified Cross-Provider Sub-Agent System - Implementation Plan

## Executive Summary

Design and implement a unified, declarative sub-agent orchestration system for SergeCode that works consistently across all providers (Claude, Codex, Cursor, Grok, Fugu, etc.) with proper provider discovery, capability detection, and programmatic workflow support similar to Claude Code's workflow system.

## Current State Analysis

### What Exists
1. **MCP Sub-Agent Toolkit** (`apps/server/src/mcp/toolkits/agents/`)
   - `SubAgentCoordinator` handles cross-provider spawning via MCP tools
   - Tools: `agent_list`, `agent_spawn`, `agent_send`, `agent_wait`
   - Works through MCP protocol, requires MCP capability grants
   - Provider-agnostic at the coordinator level

2. **Provider Architecture**
   - `ProviderInstanceRegistry` manages provider instances
   - `ProviderDriverKind` (implementation) vs `ProviderInstanceId` (routing key)
   - Built-in drivers: Codex, Claude, ClaudeSynthero, Claudex, Cursor, Grok, Fugu, OpenCode, ChatGPT
   - Each driver has adapter layers (CodexAdapter, ClaudeAdapter, etc.)

3. **Collab Agent Tool Calls** (Codex-specific)
   - Codex emits `collabAgentToolCall` items for sub-agent spawning
   - Mapped to task lifecycle events (`task.started`, `task.progress`, `task.completed`)
   - Limited to Codex's native protocol

### The Problem
1. **Provider-Specific Spawning**: When agents request sub-agents with different providers, they often fail and spawn within their own environment
2. **No Unified Discovery**: Agents can't reliably query what providers are available and what capabilities they have
3. **No Declarative Workflows**: Unlike Claude Code's JSON-based workflow system, there's no programmatic way to define multi-agent orchestration
4. **MCP-Only Access**: Sub-agent spawning is gated behind MCP capabilities, not universally accessible
5. **OpenCode Cost Concern**: OpenCode uses API credits (not subscription), needs to be excluded from sub-agent system

## Proposed Solution

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                   Agent Context (Any Provider)              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Claude     │  │    Codex     │  │   Cursor     │      │
│  │   Session    │  │   Session    │  │   Session    │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                  │                  │              │
│         └──────────────────┴──────────────────┘              │
│                            │                                 │
│         ┌──────────────────▼───────────────────┐            │
│         │   SubAgent Orchestration Service     │            │
│         │  - Provider Discovery                │            │
│         │  - Capability Detection               │            │
│         │  - Workflow Execution                 │            │
│         │  - Cross-Provider Routing             │            │
│         └──────────────────┬───────────────────┘            │
│                            │                                 │
└────────────────────────────┼─────────────────────────────────┘
                             │
         ┌───────────────────┴───────────────────┐
         │                                       │
┌────────▼─────────┐                   ┌────────▼─────────┐
│ Provider Registry│                   │ Workflow Engine  │
│ - List Instances │                   │ - JSON Executor  │
│ - Check Status   │                   │ - Parallel Tasks │
│ - Get Caps       │                   │ - Dependencies   │
└──────────────────┘                   └──────────────────┘
```

### Component Design

#### 1. **SubAgent Provider Registry Extension** (`apps/server/src/subagent/SubAgentProviderRegistry.ts`)

Enhanced provider registry focused on sub-agent capabilities:

```typescript
interface SubAgentProviderInfo {
  instanceId: ProviderInstanceId;
  driver: ProviderDriverKind;
  displayName: string;
  status: 'available' | 'unavailable' | 'disabled' | 'error';
  spawnable: boolean;
  capabilities: {
    supportsSubAgents: boolean;
    maxConcurrentSubAgents: number;
    supportedInteractionModes: ReadonlyArray<ProviderInteractionMode>;
    supportedRuntimeModes: ReadonlyArray<RuntimeMode>;
  };
  models: ReadonlyArray<{
    slug: string;
    displayName: string;
    contextWindow?: number;
    supportedOptions: ReadonlyArray<string>;
    costTier: 'cheap' | 'moderate' | 'expensive';
    concurrencyLimit: number;
  }>;
  costTier: 'free' | 'subscription' | 'api-credits';
}

interface SubAgentProviderFilter {
  excludeApiCredits?: boolean;  // Exclude OpenCode
  requireSubscription?: boolean;
  requireAvailable?: boolean;
  driverKinds?: ReadonlyArray<ProviderDriverKind>;
}
```

**Key Methods:**
- `listSpawnableProviders(filter?: SubAgentProviderFilter)`
- `getProviderCapabilities(instanceId: ProviderInstanceId)`
- `validateSpawnRequest(instanceId, model, options)`

#### 2. **Declarative Workflow System** (`apps/server/src/subagent/workflows/`)

JSON-based workflow definition similar to Claude Code:

```typescript
interface SubAgentWorkflowDefinition {
  name: string;
  description: string;
  version: string;
  phases: ReadonlyArray<WorkflowPhase>;
  defaultProvider?: ProviderInstanceId;
  parallelismLimit?: number;
}

interface WorkflowPhase {
  id: string;
  title: string;
  tasks: ReadonlyArray<WorkflowTask>;
  execution: 'sequential' | 'parallel' | 'pipeline';
}

interface WorkflowTask {
  id: string;
  type: 'spawn' | 'wait' | 'send' | 'aggregate';
  provider?: ProviderInstanceId;  // If omitted, uses defaultProvider
  model?: string;
  prompt?: string;
  dependencies?: ReadonlyArray<string>;  // Task IDs
  timeout?: number;
  onError?: 'continue' | 'abort' | 'retry';
  retryPolicy?: {
    maxAttempts: number;
    backoffMs: number;
  };
}

interface WorkflowExecutionResult {
  workflowId: string;
  status: 'completed' | 'failed' | 'partial';
  phases: ReadonlyArray<PhaseResult>;
  metrics: {
    totalDurationMs: number;
    totalTokens: number;
    totalCostUsd?: number;
  };
}
```

**Example Workflow:**
```json
{
  "name": "code-review-workflow",
  "description": "Multi-agent code review with specialized reviewers",
  "version": "1.0.0",
  "defaultProvider": "claudeAgent",
  "phases": [
    {
      "id": "discover",
      "title": "Discover Changes",
      "execution": "sequential",
      "tasks": [
        {
          "id": "list-files",
          "type": "spawn",
          "provider": "codex",
          "model": "gpt-5.5",
          "prompt": "List all modified files in this PR"
        }
      ]
    },
    {
      "id": "review",
      "title": "Parallel Review",
      "execution": "parallel",
      "tasks": [
        {
          "id": "security-review",
          "type": "spawn",
          "provider": "claudeAgent",
          "model": "opus-4.8",
          "prompt": "Review for security issues: {{files}}",
          "dependencies": ["list-files"]
        },
        {
          "id": "performance-review",
          "type": "spawn",
          "provider": "codex",
          "model": "gpt-5.5",
          "prompt": "Review for performance issues: {{files}}",
          "dependencies": ["list-files"]
        }
      ]
    },
    {
      "id": "synthesize",
      "title": "Synthesize Results",
      "execution": "sequential",
      "tasks": [
        {
          "id": "final-report",
          "type": "spawn",
          "provider": "claudeAgent",
          "model": "sonnet-5",
          "prompt": "Synthesize findings: {{security-review}} {{performance-review}}",
          "dependencies": ["security-review", "performance-review"]
        }
      ]
    }
  ]
}
```

#### 3. **Unified Sub-Agent Tool** (`apps/server/src/subagent/UnifiedSubAgentTool.ts`)

A single, provider-agnostic tool that all providers can use:

```typescript
// Replaces provider-specific implementations
const UnifiedSubAgentTool = Tool.make("unified_subagent", {
  description: "Spawn and manage sub-agents across any configured provider",
  parameters: Schema.Struct({
    action: Schema.Literals(["list", "spawn", "send", "wait", "workflow"]),
    // ... per-action parameters
  }),
  success: UnifiedSubAgentResult,
  failure: SubAgentError,
});
```

**Capabilities:**
- Available to all providers without MCP gates
- Provider discovery built-in
- Automatic exclusion of API-credit providers (OpenCode)
- Workflow execution support

#### 4. **Provider Adapter Integration**

Each adapter gets enhanced with sub-agent awareness:

**CodexAdapter Enhancement:**
```typescript
// In CodexAdapter.ts
function mapCollabAgentToolCall(item: CollabAgentToolCall) {
  // Map Codex's native collab calls to UnifiedSubAgent
  return {
    type: "unified_subagent",
    action: item.action === "spawnAgent" ? "spawn" : "wait",
    provider: resolveTargetProvider(item.config),
    // ...
  };
}
```

**ClaudeAdapter Enhancement:**
```typescript
// In ClaudeAdapter.ts  
function enrichWithSubAgentCapabilities(query: ClaudeQueryOptions) {
  return {
    ...query,
    tools: [
      ...query.tools,
      UnifiedSubAgentTool,
    ],
  };
}
```

#### 5. **Workflow Execution Engine** (`apps/server/src/subagent/workflows/WorkflowEngine.ts`)

```typescript
interface WorkflowEngine {
  execute(
    definition: SubAgentWorkflowDefinition,
    context: WorkflowExecutionContext,
  ): Effect.Effect<WorkflowExecutionResult, WorkflowError>;
  
  resume(
    workflowId: string,
    fromPhase: string,
  ): Effect.Effect<WorkflowExecutionResult, WorkflowError>;
  
  cancel(workflowId: string): Effect.Effect<void, WorkflowError>;
}
```

**Features:**
- Task dependency resolution
- Parallel execution with concurrency limits
- Pipeline execution (streaming results between tasks)
- Failure handling and retry logic
- Progress tracking
- Cost/token accumulation

## Implementation Phases

### Phase 1: Provider Registry Enhancement (Week 1)
**Files:**
- `apps/server/src/subagent/SubAgentProviderRegistry.ts` (new)
- `apps/server/src/subagent/SubAgentProviderInfo.ts` (new)
- `apps/server/src/provider/Services/ProviderRegistry.ts` (enhance)

**Tasks:**
1. Create SubAgentProviderRegistry service
2. Add capability detection for each built-in driver
3. Implement OpenCode exclusion logic
4. Add spawnable provider filtering
5. Write comprehensive tests

**Acceptance Criteria:**
- All providers report accurate capabilities
- OpenCode is never listed as spawnable when API credits flag is set
- Filtering works correctly for all criteria

### Phase 2: Unified Sub-Agent Tool (Week 2)
**Files:**
- `apps/server/src/subagent/UnifiedSubAgentTool.ts` (new)
- `apps/server/src/subagent/SubAgentCoordinator.ts` (enhance existing MCP one)
- `packages/contracts/src/subagent.ts` (new schemas)

**Tasks:**
1. Design unified tool schema
2. Implement action routing (list/spawn/send/wait)
3. Integrate with existing SubAgentCoordinator
4. Add provider validation
5. Update all adapter layers to expose tool

**Acceptance Criteria:**
- Tool available in all providers (Claude, Codex, Cursor, etc.)
- Can spawn cross-provider sub-agents
- Proper error messages when provider unavailable
- Works without MCP capability gates

### Phase 3: Adapter Integration (Week 3)
**Files:**
- `apps/server/src/provider/Layers/CodexAdapter.ts` (modify)
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` (modify)
- `apps/server/src/provider/Layers/CursorAdapter.ts` (modify)
- Similar for other adapters

**Tasks:**
1. Map Codex collabAgentToolCall to UnifiedSubAgent
2. Inject UnifiedSubAgent tool into Claude sessions
3. Add tool to Cursor, Grok, Fugu adapters
4. Update event mapping for cross-provider spawns
5. Test each adapter independently

**Acceptance Criteria:**
- All adapters can spawn sub-agents on any provider
- Native tool calls (Codex collab) mapped correctly
- Events properly tracked in parent thread
- No regressions in existing functionality

### Phase 4: Workflow System (Week 4-5)
**Files:**
- `apps/server/src/subagent/workflows/WorkflowEngine.ts` (new)
- `apps/server/src/subagent/workflows/WorkflowExecutor.ts` (new)
- `apps/server/src/subagent/workflows/WorkflowSchema.ts` (new)
- `apps/server/src/subagent/workflows/WorkflowStorage.ts` (new)

**Tasks:**
1. Implement workflow schema and validation
2. Build execution engine with phase/task support
3. Add dependency resolution
4. Implement parallel/sequential/pipeline execution modes
5. Add progress tracking and metrics
6. Create workflow storage/retrieval
7. Build workflow resume capability

**Acceptance Criteria:**
- Can parse and validate JSON workflows
- Sequential execution works correctly
- Parallel execution respects concurrency limits
- Pipeline execution streams results
- Dependencies resolved correctly
- Can resume failed workflows

### Phase 5: Integration & Testing (Week 6)
**Files:**
- Integration tests across all components
- End-to-end workflow tests
- Provider compatibility matrix tests

**Tasks:**
1. Write integration tests for cross-provider spawning
2. Test all built-in workflows
3. Performance testing (concurrent sub-agents)
4. Cost tracking validation
5. Error handling and recovery tests
6. Documentation

**Acceptance Criteria:**
- 95%+ test coverage for new code
- All providers can spawn on all other providers (except OpenCode)
- Workflows execute reliably
- Error messages are actionable
- Performance acceptable (sub-100ms overhead)

## File Structure

```
apps/server/src/subagent/
├── SubAgentProviderRegistry.ts       # Provider discovery & filtering
├── SubAgentProviderInfo.ts           # Provider capability schemas
├── UnifiedSubAgentTool.ts            # Universal sub-agent tool
├── SubAgentCoordinator.ts            # Enhanced coordinator (modify existing MCP one)
├── SubAgentError.ts                  # Error types
├── workflows/
│   ├── WorkflowEngine.ts             # Core execution engine
│   ├── WorkflowExecutor.ts           # Task executor
│   ├── WorkflowSchema.ts             # JSON schema definitions
│   ├── WorkflowStorage.ts            # Persistence layer
│   ├── WorkflowProgress.ts           # Progress tracking
│   ├── WorkflowMetrics.ts            # Cost/token tracking
│   └── builtins/
│       ├── code-review.json          # Built-in workflow
│       ├── parallel-search.json      # Built-in workflow
│       └── multi-model-eval.json     # Built-in workflow
└── __tests__/
    ├── SubAgentProviderRegistry.test.ts
    ├── UnifiedSubAgentTool.test.ts
    ├── WorkflowEngine.test.ts
    └── integration/
        ├── cross-provider-spawn.integration.test.ts
        └── workflow-execution.integration.test.ts

packages/contracts/src/
├── subagent.ts                       # SubAgent schemas & types
└── workflow.ts                       # Workflow schemas & types
```

## Provider Exclusion Strategy

### OpenCode Exclusion

**Configuration:**
```typescript
// In SubAgentProviderRegistry
const PROVIDER_COST_TIERS: Record<ProviderDriverKind, 'free' | 'subscription' | 'api-credits'> = {
  codex: 'subscription',
  claudeAgent: 'subscription',
  claudeSynthero: 'subscription',
  claudex: 'subscription',
  cursor: 'subscription',
  grok: 'subscription',
  fugu: 'subscription',
  opencode: 'api-credits',  // EXCLUDED from sub-agents
  chatgpt: 'subscription',
};

function isSpawnableProvider(provider: ServerProvider): boolean {
  const costTier = PROVIDER_COST_TIERS[provider.driver];
  
  // OpenCode excluded due to API credit costs
  if (costTier === 'api-credits') {
    return false;
  }
  
  return isProviderAvailable(provider) &&
         provider.enabled &&
         provider.installed &&
         provider.status !== 'error';
}
```

**User Communication:**
- When listing providers, mark OpenCode as `spawnable: false`
- Error message: "OpenCode uses API credits and cannot be used for sub-agents. Use Codex, Claude, or other subscription-based providers instead."

## Migration Strategy

### Backward Compatibility

1. **Existing MCP Tools**: Keep `agent_*` MCP tools working
2. **Codex collabAgentToolCall**: Map to UnifiedSubAgent transparently
3. **No Breaking Changes**: All existing sub-agent spawning continues to work

### Gradual Rollout

1. **Phase 1-3**: New system available alongside old
2. **Phase 4**: Workflow system additive (new capability)
3. **Phase 5**: Deprecation warnings for direct MCP tool usage
4. **Future**: Remove MCP-based spawning (optional, low priority)

## Success Metrics

1. **Reliability**: 99%+ success rate for cross-provider spawns
2. **Performance**: <100ms overhead for spawn operations
3. **Coverage**: All providers can spawn on all other providers (except OpenCode)
4. **Adoption**: Workflows used in 50%+ of multi-agent tasks
5. **Cost Control**: Zero accidental OpenCode spawns

## Decisions & Clarifications

1. **Workflow Storage**: ✅ DECIDED
   - **Primary**: Filesystem (`.claude/workflows/`) for user-defined workflows
   - **Backup**: Database sync for redundancy and cross-device access
   - Built-in workflows remain in code
   
2. **Concurrency Limits**: ✅ DECIDED
   - **Per-Model-Per-Provider** with global fallback
   - Cheap models (claude-haiku-4.5, gpt-4o-mini): Higher limits (20-30 concurrent)
   - Expensive models (claude-fable-5, claude-opus-4.8, gpt-5.5): Lower limits (3-5 concurrent)
   - Global max across all sub-agents as safety ceiling
   - Example config:
     ```typescript
     {
       global: { maxConcurrent: 50 },
       perModel: {
         'claude-haiku-4.5': { maxConcurrent: 30 },
         'gpt-4o-mini': { maxConcurrent: 30 },
         'claude-fable-5': { maxConcurrent: 3 },
         'claude-opus-4.8': { maxConcurrent: 5 },
         'gpt-5.5': { maxConcurrent: 5 },
       }
     }
     ```

3. **Workflow UI**: Phase 2 feature, start with JSON-only

4. **Cost Attribution**: Yes, attribute to parent thread with breakdown

5. **Workflow Sharing**: Phase 2 feature, start with local only

## Dependencies

- Effect 3.x (already in use)
- `effect/unstable/ai` toolkit (already in use for MCP tools)
- No new external dependencies required

## Risk Mitigation

1. **Performance**: Lazy load workflows, cache provider capabilities
2. **Cost Overruns**: Hard limits on concurrent sub-agents, exclude API-credit providers
3. **Complexity**: Start simple, iterate based on usage
4. **Provider Changes**: Abstract provider interfaces, minimize coupling
5. **Testing**: Comprehensive mocks for all providers in tests

## Future Enhancements (Post-MVP)

1. **Workflow Marketplace**: Share/discover workflows
2. **Visual Workflow Editor**: Drag-and-drop workflow builder
3. **Advanced Routing**: Route tasks based on provider capabilities/cost/performance
4. **Distributed Execution**: Run workflows across multiple servers
5. **Workflow Versioning**: Track workflow evolution, A/B test variations
6. **Smart Provider Selection**: ML-based provider recommendation
7. **Cost Optimization**: Automatic model downgrade for simple tasks

## Timeline Summary

- **Week 1**: Provider Registry Enhancement
- **Week 2**: Unified Sub-Agent Tool  
- **Week 3**: Adapter Integration
- **Week 4-5**: Workflow System
- **Week 6**: Integration & Testing

**Total Duration**: 6 weeks for MVP

## Next Steps

1. Review and approve this plan
2. Clarify open questions
3. Begin Phase 1 implementation
4. Set up tracking/progress dashboard
