# Environment Authentication Profile

> For maintainers. Using T3 Code? See [docs/user](../user/).

The environment server and the relay use separate credentials, issuers, and trust
boundaries. They intentionally use a similar OAuth-shaped model so that permission
checks and token exchange behavior can be audited against established concepts.

## Authorization Model

Environment authorization is capability-based. A session carries zero or more
OAuth-style scope strings:

| Scope                   | Permission                                                               |
| ----------------------- | ------------------------------------------------------------------------ |
| `orchestration:read`    | Read snapshots, status, events, configuration, and filesystem/VCS state. |
| `orchestration:operate` | Dispatch user operations and mutate environment-side workspace state.    |
| `terminal:operate`      | Create, attach, input, resize, clear, restart, and terminate terminals.  |
| `review:write`          | Read review diff previews used to compose review feedback.               |
| `access:read`           | Inspect pairing links and client sessions.                               |
| `access:write`          | Create or revoke pairing links and client sessions.                      |
| `relay:read`            | Inspect managed relay connectivity.                                      |
| `relay:write`           | Link, configure, or unlink managed relay connectivity.                   |

Ordinary pairing links grant the four client-operation scopes and read access to
managed relay connectivity:
`orchestration:read orchestration:operate terminal:operate review:write relay:read`.
The desktop bootstrap credential and command-line administrative bootstrap
credentials additionally grant `access:read access:write relay:write`.

## Host file access

Clients with `orchestration:read` can read files anywhere the environment's server account can
read, following the environment-wide authorization model rather than introducing per-project
filesystem permissions. `projects.readFile` accepts an absolute path and returns the text of that
host file; only workspace-relative paths pass its root check, and `projects.writeFile` never
accepts an absolute path. Clients use this to show files an agent wrote outside the workspace, such
as a report in a temp directory, read-only.

## Media preview access

Clients with `orchestration:read` can request a `media-file` URL through `assets.createUrl` for
supported images, videos, HTML, and PDF files anywhere the environment's server account can read.
A thread ID supplies the workspace for relative paths; absolute paths refer to the environment
host, not the client.

[`AssetAccess.ts`](../../apps/server/src/assets/AssetAccess.ts) resolves symlinks, requires a regular
file, and validates the resolved file's literal extension. It opens the file and signs its canonical
path and device/inode identity for one hour. The token grants access to that exact file, not adjacent
files or its containing directory. Serving rechecks the canonical path, media type, and opened
descriptor's identity, then streams full or partial responses from that descriptor. Replacing a
file atomically requires a freshly signed URL; editing it in place does not. Because the token names
one file, an HTML document served this way cannot load sibling assets; the directory-scoped
`workspace-file` resource remains the route for HTML inside the workspace. Uploaded attachments keep
their separate asset resource.

Signed asset URLs are bearer credentials. Anyone who obtains a URL and can reach the environment
can fetch that file until it expires. Clients should copy the authored reference, not the temporary
URL. Responses use `nosniff`; SVG responses retain their restrictive sandbox policy. Video reads
support byte ranges so playback does not require a complete download first.

Host videos can change in place, so their responses use `private, no-store` and omit `ETag`
and `Last-Modified`. File metadata cannot prove byte-for-byte identity for `If-Range`; advertising
those validators would encourage native players to send conditional seeks that require a full
response. Ordinary range requests receive partial responses. An explicitly supplied `If-Range`
still falls back to a full response because no strong validator is available. Host image previews
keep their private cache policy and weak metadata validators.

The server serves media in place without importing it into attachment storage. Deletion makes
future server reads fail, though an already loaded client or its cache can retain bytes. Native
viewers may use temporary client-side files for display or explicit sharing; those are not durable
environment copies.

## Authentication Flows

### Browser Session

`POST /api/auth/browser-session` consumes a one-time bootstrap credential and creates a
browser session cookie. The cookie is an HTTP transport adapter for the same
scoped session model; the response never exposes the session secret to browser
JavaScript.

### Bearer Access Token

Non-browser clients use `POST /oauth/token` with an
`application/x-www-form-urlencoded` body:

```text
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<bootstrap credential>
subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
requested_token_type=urn:ietf:params:oauth:token-type:access_token
scope=orchestration:read orchestration:operate terminal:operate review:write relay:read
```

Clients may additionally submit `client_label`, `client_device_type`, and
`client_os` extension parameters so the authorized-clients UI can identify the
device that established the session. These are presentation hints only; the
environment derives transport metadata such as IP address and user agent from
the request and does not use these fields for authorization.

The response has the token-exchange shape:

```json
{
  "access_token": "<opaque session token>",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "scope": "orchestration:read orchestration:operate terminal:operate review:write relay:read"
}
```

Sessions issued from a plain bearer exchange use the store's
`DEFAULT_SESSION_TTL` of 30 days. The shorter one-hour `expires_in: 3600` applies
only to DPoP-bound exchanges, where the token is additionally constrained by a
proof key. See `SessionStore.ts` and `EnvironmentAuth.ts`.

Requested scopes must be a subset of the one-time bootstrap credential grant.
An ordinary paired client therefore cannot exchange its grant for
`access:read`, `access:write`, or `relay:write`.

### DPoP-Bound Access Token

The same `/oauth/token` exchange supports proof-of-possession tokens. A client
that sends a `DPoP` header has its proof verified by `verifyRequestDpopProof`;
the resulting JWK thumbprint is stored on the session, which is then issued with
method `dpop-access-token` and a one-hour TTL instead of the bearer default. An
invalid proof gets a DPoP challenge header and a credential error rather than a
bearer token. Newer servers include a safe `dpopFailureReason` category in that
error. When an older server omits the category, clients mention clock skew as
one possible cause rather than presenting it as confirmed.

`dpop-access-token` is advertised alongside `browser-session-cookie` and
`bearer-access-token` in the descriptor's `sessionMethods`
(`EnvironmentAuthPolicy.ts`), so clients can discover support rather than
assume it. Relay-brokered clients use this mode so that a leaked token cannot be
replayed without the corresponding key.

### WebSocket Ticket

`POST /api/auth/websocket-ticket` accepts any authenticated session and returns
a short-lived, single-purpose WebSocket ticket, issued through
`EnvironmentAuth.issueWebSocketTicket` with a five-minute default TTL. The
client presents its bearer or DPoP credential in headers to get the ticket, then
appends only that ticket to the socket URL as `wsTicket`. This keeps long-lived
tokens and browser cookies out of WebSocket URLs while letting the handshake
authenticate.

The ticket carries its session's scopes; each RPC method then enforces
`orchestration:read`, `orchestration:operate`, `terminal:operate`,
`review:write`, `relay:write`, or `access:read` as appropriate, through
`RPC_REQUIRED_SCOPES` in `apps/server/src/auth/RpcAuthorization.ts`. Review feedback submission currently dispatches
an orchestration operation, so clients performing it also need
`orchestration:operate`. Creating a ticket is not authorization to call every
RPC method.

## Standards Alignment

- Bearer access tokens are used through the `Authorization: Bearer` scheme from
  RFC 6750.
- The token endpoint profiles the request and response vocabulary from OAuth 2.0
  Token Exchange (RFC 8693), including `subject_token`, `requested_token_type`,
  `access_token`, `issued_token_type`, and `token_type`.
- Scope values follow the OAuth 2.0 scope model from RFC 6749: space-delimited,
  unordered capabilities with subset checking during exchange.

This is intentionally not a general-purpose OAuth authorization server. The
environment bootstrap token type is private, the bootstrap cookie and WebSocket
connection-token routes are product-specific adapters, and the API returns its
typed `HttpApi` errors rather than implementing every OAuth error response
surface.

## Upgrade Behavior

Migration `031_AuthAuthorizationScopes` is a hard cutover from role-bearing auth
records to scoped records. It deletes existing pairing links and sessions while
leaving non-authentication environment state unchanged. Upgraded clients must
pair again; old `owner` or `client` credentials are never silently mapped to new
capabilities.

## Relay Boundary

Relay-managed tunnels use their own tokens and keys. The relay can reuse scope
parsing and token-exchange conventions, but an environment access token is not a
relay token and cannot be presented to the relay.
