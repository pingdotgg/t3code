# Remote Access Setup

Use this when you want to open T3 Code from another device (phone, tablet, another laptop).

## Expo mobile remote

This repo now includes an Expo app at `apps/mobile` that talks to the same T3 WebSocket orchestration API as the web client.

Start it with:

```bash
bun run dev:mobile
```

In the mobile app, enter:

- `Server URL`: for example `http://192.168.1.42:3773`
- `Auth token`: the same token you passed to `--auth-token` when starting the server, if any

The app derives the authenticated WebSocket URL automatically and lets you:

- browse existing threads by project
- open a thread and watch assistant streaming output
- send the next user turn
- answer approval requests and pending user-input prompts
- stop a running turn

## CLI ↔ Env option map

The T3 Code CLI accepts the following configuration options, available either as CLI flags or environment variables:

| CLI flag                | Env var               | Notes                                                                                |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `--mode <web\|desktop>` | `T3CODE_MODE`         | Runtime mode.                                                                        |
| `--port <number>`       | `T3CODE_PORT`         | HTTP/WebSocket port.                                                                 |
| `--host <address>`      | `T3CODE_HOST`         | Bind interface/address.                                                              |
| `--base-dir <path>`     | `T3CODE_HOME`         | Base directory.                                                                      |
| `--dev-url <url>`       | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target.                                                   |
| `--no-browser`          | `T3CODE_NO_BROWSER`   | Disable auto-open browser.                                                           |
| `--auth-token <token>`  | `T3CODE_AUTH_TOKEN`   | WebSocket auth token. Use this for standard CLI and remote-server flows.             |
| `--bootstrap-fd <fd>`   | `T3CODE_BOOTSTRAP_FD` | Read a one-shot bootstrap envelope from an inherited file descriptor during startup. |

> TIP: Use the `--help` flag to see all available options and their descriptions.

## Security First

- Always set `--auth-token` before exposing the server outside localhost.
  - When you control the process launcher, prefer sending the auth token in a JSON envelope via `--bootstrap-fd <fd>`.
    With `--bootstrap-fd <fd>`, the launcher starts the server first, then sends a one-shot JSON envelope over the inherited file descriptor. This allows the auth token to be delivered without putting it in process environment or command line arguments.
- Treat the token like a password.
- Prefer binding to trusted interfaces (LAN IP or Tailnet IP) instead of opening all interfaces unless needed.

## 1) Build + run server for remote access

Remote access should use the built web app (not local Vite redirect mode).

```bash
bun run build
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host 0.0.0.0 --port 3773 --auth-token "$TOKEN" --no-browser
```

Then open on your phone:

`http://<your-machine-ip>:3773`

Example:

`http://192.168.1.42:3773`

Notes:

- `--host 0.0.0.0` listens on all IPv4 interfaces.
- `--no-browser` prevents local auto-open, which is usually better for headless/remote sessions.
- Ensure your OS firewall allows inbound TCP on the selected port.
- For the Expo app in `apps/mobile`, use the same HTTP origin in the connection form and paste the token into the token field.

## 2) Tailnet / Tailscale access

If you use Tailscale, you can bind directly to your Tailnet address.

```bash
TAILNET_IP="$(tailscale ip -4)"
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host "$(tailscale ip -4)" --port 3773 --auth-token "$TOKEN" --no-browser
```

Open from any device in your tailnet:

`http://<tailnet-ip>:3773`

You can also bind `--host 0.0.0.0` and connect through the Tailnet IP, but binding directly to the Tailnet IP limits exposure.

---

## Architecture Deep-Dive

### Connection Establishment Sequence

#### 1. CLI server (`apps/server/src/cli.ts`)

- Binds the HTTP + WebSocket server directly on the selected host and port
- Uses `--auth-token` / `T3CODE_AUTH_TOKEN` for authenticated remote access
- Serves the same orchestration RPC surface the web app uses locally

#### 2. Mobile — Connection Flow (`apps/mobile/src/app/useRemoteAppState.ts`)

On app mount:

1. **Load saved connection** from secure storage (`expo-secure-store` on native, `AsyncStorage` on web)
2. **Check for deep link** — if a QR or deep link is used, the URL scheme triggers the app with `serverUrl` + `authToken`
3. If neither exists, show the **connection editor sheet**
4. Once credentials are available:
   - `resolveRemoteConnection()` normalizes the URL, infers ws/wss protocol, builds the WebSocket URL
   - `preflightRemoteConnection()` does HTTP GET to `/api/remote/health` (5s timeout)
   - Credentials saved to secure storage
   - Creates `RemoteClient` and calls `connect()`

### RPC Protocol (`apps/mobile/src/lib/remoteClient.ts`)

Custom RPC message protocol over WebSocket:

| Message Type  | Purpose                              |
| ------------- | ------------------------------------ |
| **Request**   | Unary RPC call (request -> response) |
| **Ack**       | Response to a Request                |
| **Chunk**     | Streaming data (for subscriptions)   |
| **Ping/Pong** | Keep-alive every 5s                  |
| **Exit**      | Stream completion                    |
| **Defect**    | Error response                       |

**Two RPC patterns:**

- **Unary**: `getSnapshot`, `dispatchCommand`, `getThreadMessagesPage`
- **Stream**: `subscribeOrchestrationDomainEvents` — server pushes Chunk messages as events occur

### Real-Time Data Flow

```
Backend emits OrchestrationEvent
    -> Server's subscribeOrchestrationDomainEvents stream
    -> RPC Chunk message over WebSocket
    -> Mobile RemoteClient.onChunk callback
    -> useRemoteAppState.applyRealtimeEvent()
    -> React state update -> UI re-renders
```

**Snapshot bootstrapping**: On connect, the client calls `getSnapshot` for the full read model (projects, threads, messages), then subscribes to domain events for incremental updates. Events are **sequence-ordered** — out-of-order events are buffered until the gap fills.

### Sending Commands (Mobile -> Server)

```
User taps Send
    -> enqueueThreadMessage() (optimistic UI update)
    -> client.dispatchCommand("thread.turn.start", payload)
    -> RPC Request sent directly to the CLI websocket server
    -> Backend processes, emits events back through stream
```

### Reconnection & Resilience

- **Exponential backoff**: 500ms -> 1s -> 2s -> 4s -> 8s (caps at 8s)
- **Ping/keep-alive**: Every 5s; closes socket if no pong within 5s
- **Request timeout**: 60s per request
- **Grace period**: 2.5s before showing "reconnecting" UI (avoids flash on brief drops)
- **Preflight errors**: 401 = bad token, 503 = backend not ready, network error = unreachable

### Security Model

- Token validated on every HTTP request and WebSocket upgrade
- Mobile stores credentials in `expo-secure-store` (encrypted on native)
- Auth via query param on WebSocket URL

### Key Files

| Layer  | File                                       | Role                                  |
| ------ | ------------------------------------------ | ------------------------------------- |
| Shared | `packages/shared/src/remote.ts`            | Deep link URL builder/parser          |
| Mobile | `apps/mobile/src/lib/connection.ts`        | URL resolution, preflight check       |
| Mobile | `apps/mobile/src/lib/remoteClient.ts`      | WebSocket RPC client                  |
| Mobile | `apps/mobile/src/lib/storage.ts`           | Secure credential persistence         |
| Mobile | `apps/mobile/src/app/useRemoteAppState.ts` | Central state management              |
| Server | `apps/server/src/cli.ts`                   | Host/port/auth-token remote surface   |
| Server | `apps/server/src/http.ts`                  | Remote health endpoint                |
| Server | `apps/server/src/ws.ts`                    | RPC server endpoints, event streaming |
