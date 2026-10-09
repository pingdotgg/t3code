# Cloudflare Workers + D1 deployment

This deploys a Cloudflare Worker in front of one T3 Code server. The Worker
streams the server's web app, HTTP APIs, MCP, and WebSocket connections. D1 stores
the upstream origin, which can be changed without rebuilding or redeploying.

**A T3 server is still required.** Workers cannot run provider CLIs, Git,
native terminals, or persistent workspace files. Project state and conversations
stay in the T3 server's SQLite database; this is not a D1 replacement for that
database or for the T3 Connect relay. Run the server on your computer or a VM
with persistent storage and authenticated providers. Existing web, desktop,
mobile, and provider behavior stays on the existing server.

## Set up the backend

Install T3 Code and at least one provider as described in the repository README.
Start the backend with remote authentication enabled:

```sh
t3 serve --host 0.0.0.0 --port 3773
```

Expose that port at a dedicated HTTPS origin, for example
`https://t3-origin.example.com`, using a named Cloudflare Tunnel. Keep the port
behind a firewall; the tunnel connector can reach it on loopback. Do not use
the Worker's own hostname as its upstream. Do not disable T3 authentication.

For correct MCP OAuth issuer URLs, the backend must see the **Worker's public
hostname** as its Host header and HTTPS as its forwarded protocol. In the named
tunnel's configuration, set `httpHostHeader` to the Worker hostname:

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /path/to/tunnel-credentials.json
ingress:
  - hostname: t3-origin.example.com
    service: http://127.0.0.1:3773
    originRequest:
      httpHostHeader: t3code-gateway.YOUR_SUBDOMAIN.workers.dev
  - service: http_status:404
```

Create the tunnel DNS route and run the connector using Cloudflare's named
tunnel setup. If you use a custom Worker domain, use that domain in
`httpHostHeader`. A different reverse proxy must likewise pass the public Host
and `X-Forwarded-Proto: https` to T3. T3 sessions use host-only cookies, so they
pass through the Worker without cookie-domain rewriting. Interactive Cloudflare
Access on the upstream requires additional service authentication and is not
configured by this deployment.

For T3 Connect link proofs through the Worker, generate a random secret of at
least 32 characters and set `T3CODE_WORKER_PROXY_TOKEN` in the **backend server's
environment**. Use a backend built from this branch. Store the same value as a
Worker secret (Wrangler prompts for it without putting it in command arguments):

```sh
cd infra/cloudflare
pnpm dlx wrangler@4.149.0 secret put T3CODE_WORKER_PROXY_TOKEN
```

The Worker replaces any client-supplied `X-T3Code-Proxy-Token` with its configured
secret. CloudLink verifies it before accepting forwarded authority and checks
the requested loopback origin against the server's actual listening port.
The secret does not replace T3 session authentication. Without matching secrets,
link proofs containing forwarded authority remain rejected. Keep the upstream
on HTTPS and keep the secret out of D1, source files, and logs. To revoke proxy
trust, remove the backend variable and restart the server. To rotate the secret,
update both sides; link proofs are rejected while they differ.

## Create D1 and deploy

Requires Node 24, pnpm, and a Cloudflare account. Commands below run in
`infra/cloudflare`; Wrangler is pinned and fetched by pnpm on first use.

```sh
cd infra/cloudflare
pnpm dlx wrangler@4.149.0 login
pnpm run db:create
```

Copy the returned `database_id` into `wrangler.jsonc`. Optionally change the
Worker name and database name before creating the database. Then:

```sh
pnpm run db:migrate
pnpm run configure --remote https://t3-origin.example.com
pnpm run test
pnpm run deploy:check
pnpm run deploy
```

`deploy` applies pending D1 migrations before uploading the Worker. Automated
deployments can supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead
of logging in. The token needs Workers Scripts Edit and D1 Edit permissions.
No provider credentials or T3 pairing tokens belong in D1 or Wrangler config.

Open the Worker URL and pair with the backend. When using a pairing URL emitted
by `t3 pair`, replace only its origin with the Worker URL, keeping the path,
query, and fragment intact. Use a fresh pairing link for each client.
The server serves its bundled web build through the Worker, so no separate
frontend build or hardcoded `VITE_HTTP_URL` / `VITE_WS_URL` is needed.

To switch backends, run `configure --remote` with the new HTTPS origin.
Requests read D1 on arrival; existing WebSocket connections remain on their
current backend until reconnecting. Each request performs one D1 read. All
responses bypass cache because T3 serves authenticated workspace content.

## Local development

Start a T3 server on port 3773, then in this directory:

```sh
pnpm run db:migrate:local
pnpm run configure --local http://127.0.0.1:3773
pnpm run dev
```

Wrangler uses a separate local D1 database under `.wrangler/`. Pair through its
printed local URL. MCP OAuth testing also requires your local reverse proxy to
preserve the public Host. For a full production smoke check, pair through the
Worker, start an agent turn, open a terminal, reconnect, and verify MCP discovery
names the Worker origin. A stopped backend returns 502; a missing migration or
invalid configuration returns 503. WebSocket clients should reconnect normally
after Worker deployments.
