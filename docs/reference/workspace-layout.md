# Workspace layout

- `/apps/mac`: native SwiftUI macOS client and sidecar supervisor.
- `/apps/mobile`: iPhone companion built with Expo and React Native.
- `/apps/server`: Node.js HTTP/WebSocket backend for providers, orchestration, persistence, git, and pairing.
- `/infra/relay`: optional remote connectivity and mobile activity infrastructure.
- `/packages/contracts`: Effect Schema contracts for backend, mobile, and relay boundaries.
- `/packages/client-runtime`: shared TypeScript connection and state runtime used by mobile.
- `/packages/shared`: runtime utilities with explicit subpath exports.
- `/packages/effect-codex-app-server` and `/packages/effect-acp`: typed provider protocol clients.
