# Self-hosted T3 Code

This guide exposes a T3 environment through an HTTPS/WSS reverse proxy and adds password-based
self-hosted sessions. The recommended layout keeps providers and workspaces on the Windows machine
that owns them. The VPS is only the public TLS and routing entry point.

## Architecture and limits

```text
mobile/web -> HTTPS/WSS VPS nginx -> private tunnel -> Windows T3 environment -> provider CLI
```

- Commands are authorized and executed by the environment server that owns the workspace.
- `control.sendText` can only start a normal thread turn. It cannot submit shell commands or argv.
- There is no persistent offline command queue. The environment must be online and reachable.
- A Docker deployment on the VPS creates a separate Linux environment. Its providers and
  workspaces live in that container/host; it does not control Windows-local workspaces.
- Web, desktop, and mobile use the same contracts. Direct, Tailscale, and reverse-proxy connections
  are supported as long as HTTP and WebSocket traffic reach the same environment.

## Prerequisites

- A domain with an A/AAAA record pointing to the VPS
- Ubuntu 24.04 or another current Linux distribution on the VPS
- Node.js 24 and pnpm 11 for a source deployment, or Docker Engine with Compose
- A private route from the VPS to the Windows host, preferably Tailscale or WireGuard
- TCP 80/443 open publicly; never expose the T3 origin port publicly

Install the VPS packages:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

## Build with the China mirror

The repository `.npmrc` uses `https://registry.npmmirror.com` plus the npmmirror Node, Electron,
and electron-builder mirrors. `@distilled.cloud` falls back to npm because its locked release is
not available on npmmirror.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @t3tools/web build
pnpm --filter t3 build:bundle
cp -R apps/web/dist apps/server/dist/client
```

Do not set `VITE_HTTP_URL` or `VITE_WS_URL`. The client is single-origin and nginx proxies HTTP and
WebSocket requests together.

## Create an account file

Generate a scrypt hash without putting the plaintext password in the account file:

```bash
read -rsp 'Password: ' T3_PASSWORD; echo
export T3_PASSWORD
node -e 'const c=require("node:crypto");const s=c.randomBytes(16);const d=c.scryptSync(process.env.T3_PASSWORD,s,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});console.log(`scrypt$16384$8$1$${s.toString("base64url")}$${d.toString("base64url")}`)'
unset T3_PASSWORD
```

Create `/etc/t3code/accounts.json`, owned by the service user and mode `0600`:

```json
{
  "version": 1,
  "accounts": [
    {
      "username": "demo",
      "passwordHash": "scrypt$16384$8$1$REPLACE_SALT$REPLACE_DERIVED_KEY",
      "scopes": ["orchestration:read", "orchestration:operate"],
      "label": "Demo account"
    }
  ]
}
```

Do not commit this file. The default scopes allow reading orchestration state and sending normal
turns, but do not grant access administration.

## Run the Windows origin

On Windows PowerShell, build as above and create a private data directory. Bind to a Tailscale or
LAN address that is reachable only from the VPS:

```powershell
$env:T3CODE_HOST = "100.64.0.10"
$env:T3CODE_PORT = "3773"
$env:T3CODE_HOME = "C:\ProgramData\T3CodeSelfHosted"
$env:T3CODE_NO_BROWSER = "true"
$env:T3CODE_SELFHOST_ACCOUNTS_FILE = "C:\ProgramData\T3CodeSelfHosted\accounts.json"
$env:T3CODE_SELFHOST_REQUIRE_SECURE_TRANSPORT = "true"
node apps/server/dist/bin.mjs serve
```

Change `proxy_pass` in `infra/self-hosted/nginx-t3.conf` to the private Windows address, such as
`http://100.64.0.10:3773`. Keep `X-Forwarded-Proto https`; secure-login enforcement depends on it.
Use Task Scheduler or a Windows service manager to keep the origin running.

## Run a Linux origin with systemd

Use `infra/self-hosted/t3-server.service` after placing the built repository at `/opt/t3code`.
Create `/etc/t3code/t3code.env`:

```ini
T3CODE_HOST=127.0.0.1
T3CODE_PORT=3773
T3CODE_HOME=/var/lib/t3code
T3CODE_NO_BROWSER=true
T3CODE_SELFHOST_ACCOUNTS_FILE=/etc/t3code/accounts.json
T3CODE_SELFHOST_REQUIRE_SECURE_TRANSPORT=true
```

```bash
sudo install -m 0644 infra/self-hosted/t3-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now t3-server
sudo systemctl status t3-server
journalctl -u t3-server -f
```

## Run a Linux origin with Docker

Copy `.env.example` to `.env`, create `accounts.json` beside the Compose file, then run:

```bash
cd infra/self-hosted
docker compose build
docker compose up -d
docker compose logs -f t3code
```

The Compose port is bound to `127.0.0.1`; nginx is the only public listener. Persistent state is in
the `t3code-data` volume and the account file is mounted read-only.

## TLS and nginx

Replace `t3.example.com` in `infra/self-hosted/nginx-t3.conf`, install it, then obtain a certificate:

```bash
sudo cp infra/self-hosted/nginx-t3.conf /etc/nginx/sites-available/t3code
sudo ln -s /etc/nginx/sites-available/t3code /etc/nginx/sites-enabled/t3code
sudo nginx -t
sudo certbot --nginx -d t3.example.com
sudo systemctl reload nginx
```

The long proxy timeouts and Upgrade headers are required for WebSockets. Test renewal with
`sudo certbot renew --dry-run`.

## Sessions, clients, and logs

- `GET /api/auth/clients` lists active client sessions for a session with `access:read`.
- `POST /api/auth/clients/revoke` and `/api/auth/clients/revoke-others` revoke sessions when the
  caller has `access:write`. Default self-host accounts intentionally do not have these scopes;
  pair an administrator session or remove the server-side session through the existing admin UI.
- WebSocket connect/disconnect state is tracked by the existing session store. `control.requestStatus`
  returns lightweight server/session/client status with `orchestration:read`.
- Server trace logs are below `$T3CODE_HOME/userdata/logs`; systemd logs are in journald, Docker
  logs are available through `docker compose logs`, and nginx logs are under `/var/log/nginx`.
- Control audit events include subject, session, client metadata, method, target, result, trace ID,
  text length/hash, and an 80-character normalized summary. Full message bodies are not logged.

## Local reproduction and acceptance

```bash
T3CODE_HOST=127.0.0.1 \
T3CODE_PORT=3773 \
T3CODE_HOME="$PWD/.t3-selfhost" \
T3CODE_SELFHOST_ACCOUNTS_FILE="$PWD/accounts.json" \
T3CODE_SELFHOST_REQUIRE_SECURE_TRANSPORT=false \
node apps/server/dist/bin.mjs serve

curl -i http://127.0.0.1:3773/api/login \
  -H 'content-type: application/json' \
  --data '{"username":"demo","password":"REPLACE_ME","client":{"label":"curl"}}'
```

For production acceptance:

1. Confirm HTTP redirects to HTTPS and the certificate validates.
2. Confirm a correct login returns a bearer session and wrong/missing users both return the same 401.
3. Connect web/mobile through the public URL and confirm WebSocket reconnect works.
4. Call `control.ping`, `control.requestStatus`, and `control.sendText` with their required scopes.
5. Confirm whitespace-only/oversized text and insufficient scopes are rejected and audited.
6. Revoke the test session and confirm both HTTP and WebSocket access stop.

## Rollback

Keep the previous image tag or release directory and back up `$T3CODE_HOME/userdata` before an
upgrade. For Docker, point Compose to the previous image and run `docker compose up -d`. For
systemd, restore the previous `/opt/t3code` release and restart the unit. Do not replace a live
SQLite database with a plain copy; stop the service first or use SQLite `VACUUM INTO`.

## Troubleshooting

- Login always returns 401: verify the account path, JSON version, scrypt format, file permissions,
  and the HTTPS/`X-Forwarded-Proto` path.
- Web UI loads but does not connect: verify nginx Upgrade/Connection headers and that `/ws` reaches
  the same origin as `/api`.
- 502 from nginx: verify the private Windows/Tailscale route or the loopback container port.
- Provider is missing: install and authenticate that provider on the environment host. Installing it
  only on the VPS cannot operate a Windows-owned workspace.
- Commands sent while the origin is offline are not retained; reconnect and resend after it returns.
