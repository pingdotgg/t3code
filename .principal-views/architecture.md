# T3 Code Architecture

High-level architecture overview of the T3 Code server and its subsystems.

## Overview

T3 Code is a minimal web GUI for code agents. The server wraps provider processes (currently Codex app-server) and exposes them via WebSocket to a React frontend.

## Core Components

### Web Client (apps/web)
React/Vite UI that connects to the server via WebSocket. Handles session UX, conversation rendering, and client-side state management.

### WebSocket Server
Entry point for all client communication. Routes incoming commands to appropriate handlers and pushes domain events back to connected clients. Also serves HTTP endpoints for static assets.

### Orchestration Engine
Event-sourcing command processor. Commands enter a queue, go through idempotency checks, and produce events that are atomically committed. Ensures reliable, replayable state transitions.

### Provider Session
Manages the lifecycle of provider processes (codex app-server). Handles process spawning, JSON-RPC communication over stdio, turn execution, and graceful shutdown.

### Runtime Ingestion
Bridges raw provider events into domain events. Classifies incoming events, buffers streaming content, and synthesizes high-level events for the orchestration layer.

### Terminal Manager
PTY session management for shell execution. Spawns pseudo-terminal processes, streams I/O between client and shell, handles resize events.

### Event Store
SQLite-backed persistence for orchestration events. Provides append-only event storage, read model projections, and receipt tracking for idempotency.

## Data Flow

1. Client sends command via WebSocket
2. WebSocket server routes to Orchestration Engine
3. Orchestration Engine dispatches to Provider Session
4. Provider Session communicates with codex app-server via JSON-RPC
5. Raw events flow through Runtime Ingestion
6. Domain events are committed and pushed back to client

## Key Files

- `apps/server/src/wsServer.ts` - WebSocket/HTTP server
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` - Command processing
- `apps/server/src/codexAppServerManager.ts` - Provider process management
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` - Event ingestion
- `apps/server/src/terminal/Layers/Manager.ts` - Terminal sessions
