# Phase 3: Adapter Integration - Implementation Guide

## Overview
Integrate the UnifiedSubAgentTool into all provider adapters so every provider can spawn cross-provider sub-agents.

## Dependencies
- ✅ Phase 1: SubAgentProviderRegistry
- ✅ Phase 2: UnifiedSubAgentTool

## Adapters to Modify

### 1. CodexAdapter (`apps/server/src/provider/Layers/CodexAdapter.ts`)

**Current State:**
- Maps Codex's native `collabAgentToolCall` to task lifecycle events
- Handles `spawnAgent` action

**Changes Needed:**
1. Import UnifiedSubAgentTool
2. Map `collabAgentToolCall` to UnifiedSubAgent actions
3. Maintain backward compatibility with native collab calls

**Implementation:**
```typescript
// Add to imports
import { UnifiedSubAgentTool } from '../../../subagent/UnifiedSubAgentTool.ts';

// In mapCollabAgentToolCall function
function mapCollabAgentToolCall(item: CollabAgentToolCall): ProviderRuntimeEvent {
  const action = item.action === 'spawnAgent' ? 'spawn' : 'wait';
  
  // Route through UnifiedSubAgent for cross-provider support
  return {
    type: 'item.started',
    itemType: 'dynamic_tool_call',
    toolName: 'subagent',
    payload: {
      action,
      provider: resolveTargetProvider(item.config),
      model: item.config?.model,
      prompt: item.prompt,
      // ... map other fields
    },
  };
}
```

### 2. ClaudeAdapter (`apps/server/src/provider/Layers/ClaudeAdapter.ts`)

**Current State:**
- Uses Claude SDK's tool system
- Has task tracking for Agent/Task tools

**Changes Needed:**
1. Inject UnifiedSubAgentTool into Claude query options
2. Map SDK tool calls to our system
3. Track sub-agent spawns in task maps

**Implementation:**
```typescript
// In makeClaudeQueryOptions or similar
function enrichWithSubAgentCapabilities(options: ClaudeQueryOptions) {
  return {
    ...options,
    tools: [
      ...options.tools,
      // Convert our Effect Tool to Claude SDK tool format
      convertUnifiedSubAgentToolToClaudeFormat(UnifiedSubAgentTool),
    ],
  };
}
```

### 3. CursorAdapter (if exists)

Similar pattern to ClaudeAdapter - inject tool, map calls.

### 4. Other Adapters

Apply same pattern to:
- GrokAdapter
- FuguAdapter  
- ClaudexAdapter
- ClaudeSyntheroAdapter

## Event Mapping

All adapters must emit consistent events:

```typescript
// On spawn
{
  type: 'task.started',
  payload: {
    taskId: RuntimeTaskId,
    entityType: 'subagent',
    taskType: 'sub-agent',
    subagentType: providerLabel,
    model: string,
    effort?: string,
  }
}

// On progress
{
  type: 'task.progress',
  payload: {
    taskId: RuntimeTaskId,
    summary: string,
    lastToolName: 'subagent',
  }
}

// On completion
{
  type: 'task.completed',
  payload: {
    taskId: RuntimeTaskId,
    status: 'completed' | 'failed' | 'stopped',
    summary: string,
  }
}
```

## Testing Strategy

For each adapter:
1. Test spawning on same provider
2. Test spawning on different provider
3. Test OpenCode rejection
4. Test concurrency limits
5. Test error handling

## Validation Checklist

- [ ] CodexAdapter maps collabAgentToolCall correctly
- [ ] ClaudeAdapter has tool injected
- [ ] All adapters emit consistent events
- [ ] Cross-provider spawning works
- [ ] Existing functionality not broken
- [ ] Tests pass: `vp test`
- [ ] Type check passes: `vp run typecheck`

## Migration Notes

- Keep existing MCP tools working
- Codex native collab calls transparently upgraded
- No user-facing breaking changes
