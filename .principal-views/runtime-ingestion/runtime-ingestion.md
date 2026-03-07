# Provider Runtime Ingestion

Telemetry schema for T3 Code's provider runtime event ingestion and domain event synthesis.

## Overview

The Runtime Ingestion layer bridges raw provider events into domain-level orchestration events:

- **Event Reception**: Raw events received from provider process
- **Event Processing**: Events classified, validated, and transformed
- **Session Updates**: Session state updated based on events
- **Message Buffering**: Streaming content accumulated until complete
- **Turn Finalization**: Turn results synthesized when complete

## Workflows

### event-ingestion

Tracks provider event processing from reception to domain event emission:
1. Raw event received from provider
2. Event type identified and routed
3. Session state updated
4. Domain event emitted
5. Subscribers notified

Scenarios: message-event, tool-event, turn-complete, error-event

## Key Files

- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` - Event ingestion and domain synthesis
