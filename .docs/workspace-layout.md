# Workspace layout

- `/apps/server`: Node.js WebSocket server. Wraps Codex app-server, serves the built web app, and opens the browser on start.
- `/apps/web`: React + Vite UI. Session control, conversation, and provider event rendering. Connects to the server via WebSocket.
- `/apps/desktop`: Electron shell. Spawns a desktop-scoped `harness` backend process and loads the shared web app.
- `/packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types.
- `/packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@harness/shared/git`, `@harness/shared/DrainableWorker`) — no barrel index.
