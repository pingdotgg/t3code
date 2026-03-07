# Orchestration Engine

Telemetry schema for T3 Code's event sourcing command processing engine.

## Overview

The Orchestration Engine processes commands through an event sourcing pattern:

- **Command Dispatch**: Commands enter a queue with deferred results
- **Idempotency Check**: Receipt lookup prevents duplicate processing
- **Decision Phase**: Business logic determines events to emit
- **Transaction**: Atomic event append, projection, and receipt recording
- **Publication**: Events broadcast to subscribers

## Workflows

### command-dispatch

Tracks the complete command processing lifecycle:
1. Command queued for processing
2. Receipt lookup (idempotency check)
3. Decision phase (business logic)
4. Transaction commit (events + receipt)
5. Event publication and result resolution

Scenarios: success, idempotent-hit, invariant-rejected, previously-rejected

## Key Files

- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` - Command processing and dispatch
- `apps/server/src/persistence/Layers/OrchestrationEventStore.ts` - Event persistence
- `apps/server/src/orchestration/decider.ts` - Business logic decisions
- `apps/server/src/orchestration/projector.ts` - Read model projection
