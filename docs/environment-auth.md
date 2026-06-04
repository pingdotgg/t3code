# Environment Authentication Profile

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
  "expires_in": 3600,
  "scope": "orchestration:read orchestration:operate terminal:operate review:write relay:read"
}
```

Requested scopes must be a subset of the one-time bootstrap credential grant.
An ordinary paired client therefore cannot exchange its grant for
`access:read`, `access:write`, or `relay:write`.

### WebSocket Ticket

`POST /api/auth/websocket-ticket` accepts any authenticated session and returns
a short-lived, single-purpose WebSocket ticket. This keeps bearer tokens and
browser cookies out of WebSocket URLs while allowing the socket handshake to
authenticate. The ticket carries its session's scopes; each RPC method then
enforces `orchestration:read`, `orchestration:operate`, `terminal:operate`,
`review:write`, or `access:read` as appropriate. Review feedback submission
currently dispatches an orchestration operation, so clients performing it also
need `orchestration:operate`. Creating a ticket is not
authorization to call every RPC method.

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
