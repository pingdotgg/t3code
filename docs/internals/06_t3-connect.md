# T3 Connect

T3 Connect uses Clerk for cloud identity. The relay manages environment links, bootstrap
credentials, and managed tunnel allocations. Regular HTTP and WebSocket traffic goes directly from
clients to the environment's tunnel hostname—the relay Worker is not in the data path.

The one forwarded exception is automation webhooks
([`HookForwarder.ts`](../../infra/relay/src/hooks/HookForwarder.ts)), which give senders a stable
URL while leaving token/signature verification to the environment and keeping bodies/tokens out of
traces. Opt-in offline holding stores raw webhook requests in a per-link Durable Object
([`HookInboxObject.ts`](../../infra/relay/src/hooks/HookInboxObject.ts)) rather than Queues or
Postgres because held requests need per-link ordering, retry timing, and larger payload limits.

Deployment and Clerk configuration live in the [Connect setup runbook](../operations/02_connect-setup.md).

## The relay is a trusted broker

- **DPoP-bound bootstrap minting.** For a linked user, the relay asks the environment to mint a
  one-time bootstrap credential bound to the client's DPoP key. The client redeems it directly with
  the environment for an [environment session](./04_environment-auth.md). The relay never sees session
  tokens, and a bootstrap credential is useless without the client's proof key.
- **Mutual authentication.** The environment accepts only bounded, replay-guarded relay proofs for
  its own identity, linked user, and operation; the relay verifies signed environment responses
  bound to the request nonce and client proof key so nothing behind the tunnel can impersonate the
  environment ([`CloudLink.ts`](../../apps/server/src/cloud/CloudLink.ts),
  [`EnvironmentConnector.ts`](../../infra/relay/src/environments/EnvironmentConnector.ts)).
- **Explicit trust assumption & device approval.** DPoP protects an honest exchange, not a
  compromised relay signing key. Enabling `requireConnectDeviceApproval` shifts trust from the relay
  to approved DPoP key thumbprints: untrusted keys mint credentials that cannot be spent until
  someone with `access:write` approves the key, and revoking a key revokes all of its sessions and
  pending credentials. Approving admits a device already signed in to the owner's cloud account
  and returns no credential to the approver, so `access:write` alone is enough, as it is for
  turning the setting off.
- **Anti-hijack and anti-SSRF rules.** Managed tunnels expose only the server's own loopback HTTP
  origin (ignoring caller-supplied origins). The relay refuses to relink an active environment ID
  under a different key until unlinked, resolves endpoints only from its own managed allocations,
  and never follows redirects on health or mint requests.

## Link, allocation, and tunnel lifetimes

- CLI authorization, desired exposure, and a running connector have separate lifetimes: linking can
  record intent while stopped, and logout revokes cloud credentials without uninstalling the
  background service.
- Normal CLI shutdown releases its paid tunnel while keeping the hostname reservation and allocation
  record (so the environment shows offline rather than unauthorized). Client-installed links and
  update handoffs retain the tunnel across shutdown so updates do not pay DNS/routing propagation
  delay.
- Every allocation mutation bumps its `generation`. Unlink commits authorization revocation before
  external teardown, and release/reclamation lock on the claimed generation so delayed cleanup never
  deletes a tunnel reused by a concurrent restart or relink
  ([`ManagedEndpointProvider.ts`](../../infra/relay/src/environments/ManagedEndpointProvider.ts)).
- Idle tunnel reclamation deletes only tunnels whose host has registered recovery (and never
  unallocated orphans) so hosts that cannot self-heal are left alone.

## T3 Chat plan cap link

T3 Chat uses WorkOS rather than Clerk, so accounts link by user consent via a shared secret. T3 Chat
owns the link and plan state; the relay stores no copy and queries T3 Chat only when an account hits
its default cap for a new environment, failing closed to the default cap without disrupting existing
slots.

## OAuth traps

- Interactive clients use Clerk session-template JWTs; the headless CLI uses a public PKCE OAuth
  client with no secret. The relay must accept both.
- Loopback CLI login starts on the hosted `/connect` page so sign-in finishes before Clerk's
  authorize endpoint (going straight to authorize drops parameters across sign-in redirects).
- SSH and headless sessions use Clerk's OAuth device authorization grant directly against Clerk's
  token endpoint, which must stay enabled on the CLI OAuth application.
