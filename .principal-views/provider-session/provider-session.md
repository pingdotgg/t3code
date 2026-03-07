# Provider Session Lifecycle

Telemetry schema for T3 Code's provider session management.

## Overview

The Provider Session Lifecycle tracks agent sessions through the Codex app-server JSON-RPC protocol. It covers:

- **Session Start**: Spawning the app-server process, initializing JSON-RPC, reading account info, and opening/resuming threads
- **Turn Submission**: Sending user input to the provider, model resolution, and turn state tracking
- **Session Stop**: Graceful cleanup, process termination, and state persistence

## Workflows

### session-start

Tracks the full session initialization flow:
1. Process spawn and JSON-RPC initialization
2. Account snapshot capture
3. Thread open (fresh start or resume with fallback)
4. Ready state transition

Scenarios: success, failure, resume-success, resume-fallback, timeout

### send-turn

Tracks turn submission and completion:
1. Input validation
2. Model resolution
3. Turn start RPC call
4. Turn completion (success/failure/interrupt)

Scenarios: success, failure, interrupted

### session-stop

Tracks session cleanup:
1. Pending request cancellation
2. Process termination
3. State persistence
4. Resource cleanup

Scenarios: success, forced-exit

## Key Files

- `apps/server/src/codexAppServerManager.ts` - Core session/turn management
- `apps/server/src/provider/Layers/ProviderService.ts` - Cross-provider orchestration
