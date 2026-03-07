# WebSocket Command Routing

Telemetry schema for T3 Code's WebSocket server request routing and response handling.

## Overview

The WebSocket server handles bidirectional communication between web clients and the server:

- **Request Reception**: Incoming WebSocket messages parsed as commands
- **Command Routing**: Messages routed to appropriate handlers based on method
- **Response Handling**: Results serialized and sent back to clients
- **Error Recovery**: Graceful handling of malformed requests and handler failures

## Workflows

### request-lifecycle

Tracks complete request processing from reception to response:
1. Message received from WebSocket connection
2. Message parsed and validated
3. Request routed to handler
4. Handler executes and returns result
5. Response sent to client

Scenarios: success, validation-error, handler-error

## Key Files

- `apps/server/src/wsServer.ts` - WebSocket server and request routing
