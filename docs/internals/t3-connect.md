# T3 Connect

T3 Connect uses Clerk for cloud identity. The relay manages environment links,
credentials for reaching environments, and managed tunnel allocations. After
bootstrap, clients send application traffic through the environment's tunnel
hostname; the relay Worker does not proxy their HTTP or WebSocket sessions.

Clerk, deployment, and native authentication setup live in the
[Connect setup runbook](../operations/connect-setup.md).

## The relay is a trusted broker

An authenticated cloud user still needs an active environment link. The relay
asks that environment to mint a one-time bootstrap credential bound to the
client's DPoP key. The client exchanges it directly with the environment for an
[environment session](./environment-auth.md). The relay never receives that
session token, and possessing the bootstrap credential alone does not permit
redeeming it without the client's private key.

Both sides authenticate this exchange. The environment accepts only bounded,
replay-guarded relay proofs for its own identity, linked user, and requested
operation. Signed environment responses bind the result to the request nonce;
mint responses also bind the credential to the client proof key. The relay
verifies those bindings before returning a credential. This prevents a different
process behind the tunnel from impersonating the linked environment. The checks
meet in the
[environment cloud handlers](../../apps/server/src/cloud/http.ts) and
[relay connector](../../infra/relay/src/environments/EnvironmentConnector.ts).

The relay holds the signing authority for mint requests. DPoP protects an honest
exchange from credential reuse; it does not make a compromised relay signing
key harmless. Keep that trust assumption explicit when changing the protocol.

Managed tunnels expose only a validated loopback HTTP origin. Link proof checks
reject forwarded authority headers, and the relay resolves endpoints from its
own managed allocations rather than a caller-supplied URL. Health and mint
requests must not follow redirects. These restrictions keep endpoint discovery
from turning into arbitrary relay egress or exposing another service on the
environment host.

## A link outlives a connector process

CLI authorization, desired exposure, and a running connector have different
lifetimes. Linking can record intent while the server is stopped. Startup
reconciles that intent. CLI logout removes the stored cloud credential and
disables exposure without uninstalling the environment's background service.

Managed allocations belong to a user/environment pair. Provisioning checkpoints
external tunnel and DNS resources so retries can reconcile partial work. A
normal shutdown of a CLI-managed link releases its tunnel to avoid paying for
an idle resource, retaining the hostname reservation for the next startup.
It also retains the allocation record so the environment remains "offline"
rather than becoming "not authorized".

Two cases must retain the tunnel across shutdown. A link installed through a
client has no startup provisioning path and depends on its stored connector
token. An update handoff immediately starts a replacement server, and replacing
the tunnel would add routing propagation delay to every update. These exceptions
belong to [shutdown handling](../../apps/server/src/cloud/http.ts).

Release and unlink claim the allocation generation before deleting external
resources. A delayed cleanup must not delete a tunnel reused by a concurrent
restart or relink. Unlink commits authorization revocation before external
teardown, because a database failure must leave the active link usable. Failed
teardown retains enough state to retry. See the
[managed endpoint lifecycle](../../infra/relay/src/environments/ManagedEndpointProvider.ts).

## OAuth traps

Interactive clients and the headless CLI use the same Clerk application but
different credentials. The relay accepts both session-template JWTs and CLI
OAuth tokens; requiring a JWT template for the CLI would reject valid logins.
The CLI is a public OAuth client using PKCE and stores no client secret.

CLI authorization starts on the hosted `/connect` page so sign-in completes
before entering Clerk's authorize endpoint. Sending a signed-out browser
straight to that endpoint loses the authorize parameters during the sign-in
redirect. The [shared flow](../../packages/shared/src/connectAuth.ts) preserves
PKCE and state for both loopback and pasted-code callbacks. SSH and headless
sessions use the pasted-code flow because the browser cannot ordinarily reach a
listener on the remote machine.
