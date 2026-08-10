# T3 Relay Self

> For maintainers. Using T3 Code? See [docs/user](../user/).

T3 Relay Self is a second relay implementation that an operator runs on their own machine. It
serves the same [relay contract](../../packages/contracts/src/relay.ts) as the hosted relay in
[`infra/relay`](../../infra/relay), but it depends on no managed service. The hosted relay stays in
place and keeps its current behavior. Clients pick one or the other from a setting.

The hosted relay depends on Clerk, PlanetScale, Cloudflare and Axiom. T3 Relay Self replaces those
with an identity provider it embeds (Better Auth), an ordinary PostgreSQL database, an outbound
tunnel the environment dials itself, and no tracing backend.

The point is that one person can stand it up without an account anywhere, and that an organization
can review, host and audit the whole path itself. Nothing in the connection leaves infrastructure
the operator controls, which is what a corporate security or legal review usually needs to see.

## Shape

```
  Client (web, desktop, mobile, CLI)
      |
      |  setting: "self-hosted relay" + address
      v
  +----------------------------------+
  | T3 Relay Self                    |  apps/relay-selfhost, one container
  | one public name, one certificate |
  |                                  |
  | Better Auth on /api/auth         |
  | web assets, mounted last         |
  | relay contract on /v1            |---> packages/relay-core
  | environment gateway on /e/<id>/* |         (shared domain logic)
  | tunnel endpoint on /tunnel       |
  +----------------------------------+
      |
      |  one long-lived connection, dialed outward by the environment
      v
  +----------------------------------+
  | T3 Code server on the operator's machine
  +----------------------------------+
```

## Design decisions

**Shared domain logic lives in `packages/relay-core`.** Environment linking, credentials, DPoP
tokens and agent activity do not depend on a host. Both relays import them. Each relay keeps only
its own infrastructure wiring. The alternative, copying the logic, guarantees divergence.

**All environment traffic passes through the relay.** The relay proxies `/e/<environmentId>/*` down
the environment's own tunnel. Direct peer-to-peer would need a public DNS name and a certificate per
machine, which in turn needs an API credential at the operator's DNS provider. Routing by path keeps
the deployment to a single name and a single certificate.

**The environment reaches the relay by dialing outward over 443.** Consumer routers block inbound
connections, so the environment has to open the connection and hold it. An IP-level tunnel such as
WireGuard would add a UDP port, a virtual network interface, and elevated privileges on macOS and
Windows, and it would buy nothing once every request is proxied anyway. An outbound connection on
443 also survives corporate firewalls that drop UDP.

**The certificate is issued over HTTP validation on port 80.** Nothing is required at the DNS
provider beyond one address record pointed at the host. The relay terminates TLS itself, so no
reverse proxy sits in front of it.

**Better Auth is reached over plain HTTP by clients, not through its client library.** Four client
platforms are involved, two of which (Electron, Expo) have no official integration.

**Notification delivery is a PostgreSQL table polled on an interval.** The hosted relay uses
Cloudflare Queues. Adding a queue broker to the self-hosted deployment would add a service the
operator has to run and back up.

**Apple push stays off unless the operator supplies credentials.** APNs is owned by Apple and
cannot be self-hosted. An operator with their own Apple credentials and their own app build can
enable it with a configuration flag.

## Authentication

Sign-in uses a username, a password, and optionally a security key. No email is sent, so no SMTP
service is required. Password recovery is therefore an operator action, not a self-service flow.

The token exchange is the only boundary that differs from the hosted relay. The hosted relay
verifies a Clerk JWT and issues a DPoP access token. T3 Relay Self verifies a Better Auth session
and issues the same DPoP access token. Everything downstream of the exchange is unchanged, including
scopes, DPoP proof handling, and environment credentials. Read
[Environment Authentication Profile](./environment-auth.md) before changing any of it.

The first account is created through a single-use link written to the container logs on first start.

## Reachability

The hosted relay provisions a Cloudflare Tunnel and downloads `cloudflared` onto the operator's
machine. T3 Relay Self needs no downloaded binary. The environment opens a long-lived connection to
`/tunnel` on the relay and keeps it open, and the relay multiplexes proxied requests back down it.

The relay contract already declares a `t3_relay` provider kind next to `manual` and
`cloudflare_tunnel`. It is reserved and unimplemented today, and it describes exactly this path, so
the contract does not change.

## Deployment

The relay needs one host reachable from the internet and one name pointed at it. It does not need a
reverse proxy, a DNS API credential, or a wildcard certificate.

```yaml
services:
  relay:
    image: ghcr.io/pingdotgg/t3-relay-selfhost
    environment:
      RELAY_PUBLIC_NAME: relay.example.com
      RELAY_CERT_EMAIL: operator@example.com
    ports: ["80:80", "443:443"]
    volumes: ["data:/data"]
  db:
    image: postgres:17
    volumes: ["pgdata:/var/lib/postgresql/data"]
```

## Client configuration

Every client stores whether it targets the hosted relay or a self-hosted one, plus the address of
the self-hosted relay. The hosted relay stays the default, and an untouched setting keeps current
behavior exactly.

| Client  | Storage                                      | Entry point                                                     |
| ------- | -------------------------------------------- | --------------------------------------------------------------- |
| Web     | Browser local storage                        | `apps/web/src/components/settings/ConnectionsSettings.tsx`      |
| Desktop | Browser local storage in the Electron window | Same settings surface                                           |
| Mobile  | Device secure store                          | `apps/mobile/src/features/settings/SettingsAuthRouteScreen.tsx` |
| CLI     | Existing secret store, key `cloud-relay-url` | `t3 connect login --relay <url>`                                |

The CLI signs in with a username and a password. A security key needs a browser or a platform
authenticator, so it is not available on a headless terminal.

## Known costs

The operator's upstream bandwidth bounds every session, because all environment traffic is proxied.

Apple push notifications and Live Activities are unavailable unless the operator ships their own
build with their own Apple credentials.

There is no tracing backend. Diagnostics come from container logs.
