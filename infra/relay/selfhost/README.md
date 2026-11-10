# Self-hosted T3 relay

Runs the T3 Connect control plane on your own server with Docker Compose: a relay, Postgres,
and Caddy terminating HTTPS. Sign-in comes from your own OpenID Connect provider, so no Clerk
account is needed.

Every web, desktop, mobile and CLI client signed in to the same account sees the same linked
environments, and opens their projects and threads live through them; that is how clients stay
in sync. Thread data stays on each environment, never on the relay.

## Setup

Run these from the repository root.

1. Create the cloud-mint signing keys (once):

   ```sh
   infra/relay/selfhost/gen-keys.sh
   ```

2. Configure the stack:

   ```sh
   cp infra/relay/selfhost/.env.example infra/relay/selfhost/.env
   ```

   Set `RELAY_DOMAIN` and `RELAY_PUBLIC_ORIGIN` to the host name that resolves to this server,
   `OIDC_ISSUER` to your provider's issuer URL, and `POSTGRES_PASSWORD` to a real password.
   Keep the generated mint keys and the Postgres password in your secret manager.

3. In your identity provider, create one public OAuth client (authorization code with PKCE, no
   secret) for the T3 Code apps, and set `OIDC_AUDIENCE` to its client id. The apps send the
   provider's **ID token** to the relay, so its `aud` is that client id and its `sub` identifies
   the user. Allow these redirect URIs:

   | Client  | Redirect URI                                                   |
   | ------- | -------------------------------------------------------------- |
   | Web     | `https://<your web app origin>/oidc/callback`                  |
   | Desktop | `t3code://app/oidc/callback` (`t3code-dev://…` for dev builds) |
   | Mobile  | `t3code://oidc` (`t3code-dev://oidc`, `t3code-preview://oidc`) |
   | CLI     | `http://127.0.0.1:34338/callback`, or enable the device flow   |

   Request the `offline_access` scope so sessions refresh without signing in again.

4. Start it:

   ```sh
   docker compose -f infra/relay/selfhost/docker-compose.yml --env-file infra/relay/selfhost/.env up -d --build
   ```

5. Check it:

   ```sh
   curl https://<RELAY_DOMAIN>/health        # {"ok":true,"service":"relay"}
   ```

   Requests without a bearer token get `401`. Caddy obtains the certificate automatically when
   `RELAY_DOMAIN` is a public name that reaches this server on ports 80 and 443.

## Backups and upgrades

The Postgres volume is the source of truth for relay state. Back it up with your normal
Postgres tooling, for example:

```sh
docker compose -f infra/relay/selfhost/docker-compose.yml exec -T postgres \
  pg_dump -U relay relay > relay-$(date +%Y%m%d).sql
```

Back up the `infra/relay/selfhost/secrets` directory separately. Restore the database and keys
before starting a new relay image; migrations run automatically and the process refuses to serve
if a migration fails.

## Point the apps at this relay

In each app, open **Settings → Connections → T3 Connect service**, choose **Self-hosted relay**,
and enter `https://<RELAY_DOMAIN>`. The app reads the identity provider from the relay's
`/.well-known/t3-relay` (`OIDC_ISSUER`, and `OIDC_AUDIENCE` as the client id), so nothing else
needs typing. Check what the apps will see with:

```sh
curl https://<RELAY_DOMAIN>/.well-known/t3-relay
# {"oidc":{"issuer":"https://sso.example.com/realms/t3","clientId":"t3-code"},"managedTunnels":false}
```

The `t3` server and CLI read the relay from the environment instead:

```sh
T3CODE_RELAY_URL=https://relay.example.com
T3CODE_OIDC_ISSUER=https://sso.example.com/realms/t3
T3CODE_OIDC_CLIENT_ID=t3-code
```

A fork can also make the relay its build's default by setting the same three variables in the
repository's `.env` before building web, desktop or mobile (`scripts/lib/public-config.ts` maps
them to each app's prefix). A configured OpenID Connect provider replaces Clerk in that build.

## Reach an environment without a tunnel

**Through the relay (no address to expose).** Set `RELAY_CHANNEL_HOST` to a host pattern such as
`t3-*.example.com`. An environment linked without its own public address then keeps one outbound
WebSocket open to the relay, and the relay serves it at `https://t3-<key>.example.com`, forwarding
HTTP and WebSocket traffic over that socket. Nothing to open on the environment's network. Route
the pattern to the relay at your proxy with a wildcard DNS record and a wildcard certificate (the
bundled Caddy serves only `RELAY_DOMAIN`; a wildcard certificate needs Caddy's DNS challenge).
All of that environment's traffic passes through the relay host, and channels live in the relay
process, so keep a single replica.

**At an address you expose.** With `RELAY_MANUAL_ENDPOINTS=public` (the default here), an
environment can publish an HTTPS address you already expose (reverse proxy, port forward) and the
relay brokers connections to it like a managed endpoint. Run `t3 connect --publish-only`, then
start the server with `T3CODE_PUBLIC_URL` set to that address:

```sh
t3 connect --publish-only
T3CODE_PUBLIC_URL=https://t3.example.com t3 serve
```

The address must serve the environment's HTTP and WebSocket traffic over HTTPS. The relay
refuses loopback, link-local and cloud metadata addresses. `private` also accepts private
network addresses (LAN, Tailscale) for relays only your own network uses; `off` refuses all of
them. Host names are checked as written, not resolved, so only point a relay you trust at names
you control. A published address takes precedence over a relay channel.

## Behind another reverse proxy

Caddy is the bundled proxy. To use your own (nginx, Traefik, a cloud load balancer), drop the
`caddy` service, point your proxy at the relay's port 8080, and keep `RELAY_PUBLIC_ORIGIN` at
the public HTTPS address. The relay builds no URLs from request headers, so `X-Forwarded-*`
values are ignored. It reads `Host` only to match `RELAY_CHANNEL_HOST`, so pass it through. `OIDC_ISSUER` must equal the issuer your provider reports
publicly, including any path prefix your proxy adds.

## What this host does not do

- **Managed tunnels.** Cloudflare-managed endpoints are not available; use a relay channel or
  a manual endpoint (above), or reach environments directly.
- **Push notifications.** APNs and FCM need credentials tied to the mobile app's signing
  identity, so this stack turns them off. To enable them, add `APNS_ENABLED=true`, the `APNS_*`
  or `FCM_SERVICE_ACCOUNT` variables and a stable `APNS_DELIVERY_JOB_SIGNING_SECRET` (for
  example `openssl rand -hex 32`) to the `relay` service environment.
- **Held webhooks.** Webhooks are not stored while an environment is offline.
- **Clerk accounts and T3 Chat linking.** Sign-in is OIDC only. Adding `CLERK_SECRET_KEY`,
  `CLERK_PUBLISHABLE_KEY` and `CLERK_JWT_AUDIENCE` to the `relay` service also accepts Clerk.
- **Scale.** Queues and rate limits are in memory, so run one replica. Queued push jobs do not
  survive a restart.
