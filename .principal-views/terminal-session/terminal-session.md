# Terminal Session Lifecycle

Telemetry schema for T3 Code's PTY terminal session management.

## Overview

The Terminal Manager handles pseudo-terminal sessions for shell execution:

- **Session Open**: Terminal requested with shell and working directory
- **Shell Resolution**: Appropriate shell binary resolved
- **PTY Spawn**: Pseudo-terminal process spawned
- **Data Flow**: Input/output streamed between client and PTY
- **Session Close**: Terminal process terminated and cleaned up

## Workflows

### session-lifecycle

Tracks complete terminal session from open to close:
1. Terminal open requested
2. Shell binary resolved
3. PTY process spawned
4. Session ready for I/O
5. Session closed (exit or disconnect)

Scenarios: success, shell-error, spawn-error, disconnect

## Key Files

- `apps/server/src/terminal/Layers/Manager.ts` - Terminal session management
