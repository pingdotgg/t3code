# Phase 3: Adapter Integration - Implementation Guide

## Integration Pattern

All adapters follow the same pattern:

```typescript
import { createUnifiedSubAgentToolHandler } from '../../subagent/integration.ts';

// In adapter context
const handler = createUnifiedSubAgentToolHandler({
  threadId: currentThreadId,
  providerInstanceId: currentProviderInstanceId,
});

// Call handler with tool input
const result = yield* handler({
  action: 'spawn',
  providerInstanceId: 'codex',
  model: 'gpt-5.5',
  prompt: 'Task description...'
});
```

## Adapters to Integrate

### ✅ 1. Integration Layer (DONE)
File: `apps/server/src/subagent/integration.ts`
- Generic handler creation
- Codex collabAgent mapping
- Helper functions

### 🔄 2. CodexAdapter
File: `apps/server/src/provider/Layers/CodexAdapter.ts`

**Current**: Maps `collabAgentToolCall` to task events
**Change**: Route through UnifiedSubAgentTool for cross-provider support

**Location**: Search for `collabAgentToolCall` handling
**Add**:
```typescript
import { mapCodexCollabAgentToUnified, createUnifiedSubAgentToolHandler } from '../../subagent/integration.ts';

// When handling collabAgentToolCall:
if (item.type === "collabAgentToolCall") {
  const unified = mapCodexCollabAgentToUnified(item);
  if (unified) {
    const handler = createUnifiedSubAgentToolHandler({
      threadId: session.threadId,
      providerInstanceId: adapterOptions.instanceId,
    });
    // Execute unified handler
    yield* handler(unified);
  }
}
```

### 🔄 3. ClaudeAdapter
File: `apps/server/src/provider/Layers/ClaudeAdapter.ts`

**Current**: Uses Claude SDK tool system
**Change**: Add subagent as available tool

**Location**: Find where tools are configured for Claude query
**Add**:
```typescript
import { createUnifiedSubAgentToolHandler } from '../../subagent/integration.ts';

// In query options or tool list:
const tools = [
  ...existingTools,
  {
    name: "subagent",
    description: "Spawn and manage sub-agents across providers...",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "spawn", "send", "wait"] },
        providerInstanceId: { type: "string" },
        model: { type: "string" },
        prompt: { type: "string" },
        threadId: { type: "string" },
        timeoutSeconds: { type: "number" }
      }
    }
  }
];

// When tool is called, route to handler
```

### 🔄 4-8. Other Adapters

Same pattern for:
- **CursorAdapter** (apps/server/src/provider/Layers/CursorAdapter.ts)
- **GrokAdapter** (apps/server/src/provider/Layers/GrokAdapter.ts)
- **FuguAdapter** (apps/server/src/provider/Layers/FuguAdapter.ts)
- **ClaudexAdapter** (apps/server/src/provider/Layers/ClaudexAdapter.ts)
- **ClaudeSyntheroAdapter** (apps/server/src/provider/Layers/ClaudeSyntheroAdapter.ts)

**Note**: OpenCodeAdapter should NOT get the tool (excluded provider)

## Testing Checklist

For each adapter:
- [ ] Tool is available (shows in provider capabilities)
- [ ] Can list providers (returns accurate list)
- [ ] Can spawn on same provider
- [ ] Can spawn on different provider
- [ ] OpenCode not in spawnable list
- [ ] Concurrency limits enforced
- [ ] Error messages clear

## Validation

```bash
# Run adapter tests
vp test apps/server/src/provider/Layers/CodexAdapter.test.ts
vp test apps/server/src/provider/Layers/ClaudeAdapter.test.ts

# Run integration tests
vp test apps/server/src/subagent/__tests__/integration.test.ts
```

## Status

✅ Integration layer created
⏳ CodexAdapter - Needs implementation
⏳ ClaudeAdapter - Needs implementation  
⏳ Other adapters - Needs implementation
⏳ Tests - Needs creation
⏳ Validation - Needs execution

The integration.ts file provides all the helpers needed. Each adapter just needs to:
1. Import the helpers
2. Create handler with context
3. Route tool calls to handler
