# Remote Access Setup

Use this when you want to open T3 Code from another device (phone, tablet, another laptop).

## CLI ↔ Env option map

The T3 Code CLI accepts the following configuration options, available either as CLI flags or environment variables:

| CLI flag                | Env var               | Notes                              |
| ----------------------- | --------------------- | ---------------------------------- |
| `--mode <web\|desktop>` | `T3CODE_MODE`         | Runtime mode.                      |
| `--port <number>`       | `T3CODE_PORT`         | HTTP/WebSocket port.               |
| `--host <address>`      | `T3CODE_HOST`         | Bind interface/address.            |
| `--state-dir <path>`    | `T3CODE_STATE_DIR`    | State directory.                   |
| `--dev-url <url>`       | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target. |
| `--no-browser`          | `T3CODE_NO_BROWSER`   | Disable auto-open browser.         |
| `--auth-token <token>`  | `T3CODE_AUTH_TOKEN`   | WebSocket auth token.              |

> TIP: Use the `--help` flag to see all available options and their descriptions.

## Security First

- Always set `--auth-token` before exposing the server outside localhost.
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

## 3) Desktop app in remote/shared-history mode

Use this when your phone/web UI is the source of truth and you want desktop to attach to the same backend.

1. Start one server (same as above) with a persistent `--state-dir` and `--auth-token`.
2. Launch the desktop app with these environment variables:

```bash
export T3CODE_DESKTOP_REMOTE_URL="https://your-server.example.com"
export T3CODE_DESKTOP_REMOTE_AUTH_TOKEN="$TOKEN"
```

Then start T3 Code Desktop normally.

You can also open `Settings -> Shared History` inside the desktop app, save the same URL/token
there, and let the app restart itself into remote mode.

Behavior in remote mode:

- Desktop connects directly to the configured remote WebSocket/backend.
- Desktop does **not** start its own persistent local chat backend.
- History shown in desktop comes from that shared remote server state.
- On auth or connectivity failure, desktop surfaces the error and does not silently fall back to local mode.

### Protocol expectations

- `http://...` remote URL -> desktop WebSocket uses `ws://...`
- `https://...` remote URL -> desktop WebSocket uses `wss://...`
- If your remote URL already uses `ws://` or `wss://`, it is used as-is.

For reverse proxies/Tailscale, set `T3CODE_DESKTOP_REMOTE_URL` to the externally reachable URL your phone/browser also uses.
