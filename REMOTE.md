# Remote Access Setup

Use this when you want to open T3 Code from another device (phone, tablet, another laptop).

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
