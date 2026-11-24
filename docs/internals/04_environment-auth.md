# Environment authentication

The environment issues its own sessions and enforces their capabilities. Cloud identity and relay
credentials belong to a separate trust boundary, described in [T3 Connect](./06_t3-connect.md). A relay
token is never an environment login. See [SECURITY.md](../../SECURITY.md) for the overall threat
model.

## Scoped sessions and delegation

- **Narrowing only.** Pairing delegates a set of scopes. Exchanging a bootstrap credential can
  narrow a grant, never widen it. Client labels and device metadata have no authorization role.
- **`access:write` hands out what the session holds and revokes anything.** Every route that
  returns a credential to the caller requires `access:write` and every scope that credential
  carries: a pairing link, an MCP sign-in approval, a link code from a linked environment, and a
  guest link (which reads a thread). Revoking is not capped by the caller's scopes. Admitting a
  T3 Connect device is not delegation; see [T3 Connect](./06_t3-connect.md).
- **Why the default grant includes management scopes.** `terminal:operate` and
  `orchestration:operate` already grant OS-user execution (which can invoke `t3 auth session issue`),
  so withholding access or relay management from the default grant would not be a real boundary.
  Narrower clients receive explicit scopes.
- **No recoverable secrets in read models.** Only the creation response returns a raw pairing
  credential; access listings expose metadata only.
- **DPoP binding.** Browser cookies, bearer tokens, and DPoP tokens share the scoped session model.
  DPoP binds tokens to a client proof key; an invalid proof must fail rather than fall back to
  bearer auth. Plain paired DPoP sessions renew in place so live sockets and Sharing & access rows
  stay stable; T3 Connect, CLI, and desktop sessions never self-renew so revoking/unlinking cuts
  them off.
- **WebSocket tickets and per-RPC authorization.** Bearer and DPoP clients mint short-lived tickets
  over authenticated HTTP so long-lived tokens never appear in socket URLs. DPoP RPC tickets stay
  proof-key bound at upgrade. A successful handshake grants no extra authority: every RPC declares
  and checks its required scope in [`RpcAuthorization.ts`](../../apps/server/src/auth/RpcAuthorization.ts).
- **Secret references need `providers:manage`.** A request that names a secret for the server to
  read needs `providers:manage` on top of its method's scope, whether the reference is saved in
  settings or used once, as in a secret request answered with a reference. Typed values need only
  the method's scope. Clients hide the secret provider picker from sessions without it.
- **Project scripts need `orchestration:operate`.** The host runs a saved project script itself,
  on worktree creation and on settle, so saving one needs `orchestration:operate` on top of
  `settings:write`, whether it arrives in a settings patch or a project update.
- **Backward-compatible scope evolution.** Token exchange intersects requested scopes with the
  pairing grant, dropping retired/unknown names and failing before consuming a link if none remain.
  Stored grants are never expanded when scopes split. Auth responses preserve legacy `scopes`
  alongside exact `permissions` so older clients and servers stay compatible.

## Non-standard principals

- **Guest links are not sessions.** [GuestShareService](../../apps/server/src/guest/GuestShareService.ts)
  issues HMAC tokens bound to one share in the thread projection—never `SessionStore` rows—so no
  RPC, WebSocket, or MCP route can accept one. Closing, replacing, or archiving the share revokes
  every token. Guest routes also require T3 Connect to still serve the link's hostname (never rely
  on the request `Host` header alone).
- **MCP clients (`mcp-client`) are a separate audience.** Outside agents authenticate on `/mcp` via
  PKCE OAuth ([McpOAuth](../../apps/server/src/auth/McpOAuth.ts)), with stateless client
  registration so unauthenticated callers cannot grow server state. Users grant read-only access or
  a runtime-mode ceiling rather than raw scopes. Every non-`/mcp` HTTP and WebSocket route rejects
  `mcp-client` sessions (except the read-only thread relay and client-pairing routes restricted to
  [peer links](./05_remote.md#peer-links)). Every MCP tool must statically declare its access level in
  [`McpToolAccess.ts`](../../apps/server/src/mcp/McpToolAccess.ts), and thread-only tools must still
  refuse outside callers in handlers—hiding from tool listings is only discovery. A workflow run
  picks its own modes, so only a caller at the broadest mode a thread may run in here (full access,
  or an administrator's ceiling below it) can start or change runs, change what workflows store, or
  read webhook paths. Narrower callers can still read runs.
- **Peer-link client pairing.** Only a full-access peer link may mint a one-time client pairing on
  the linked environment (since full-access agents can already run `t3 auth pairing create`). The
  linked side enforces this itself, and the operation stays a human-triggered RPC/HTTP route rather
  than an MCP tool. The same route mints a code that links another environment at a chosen access
  level, and the linking side's RPC requires the caller to hold that level's scopes.

### Reusable dev credential

Web development servers can accept a fixed `T3CODE_DEV_AUTH_TOKEN` across worktrees and ports on one
hostname (see the [development runbook](../operations/00_development.md#reusable-dev-credential)). It
grants administrative access and is ignored by desktop and non-development servers.

Each environment hashes the value into its own database record and keeps independent SQLite state,
signing keys, and revocation state. Normal credentials always take precedence: a rejected normal
credential never falls back to the reusable dev credential.

## The environment is the filesystem boundary

Projects are organizational boundaries, not filesystem sandboxes. `filesystem:read` permits reading
any file the server's OS user can read (for example, artifacts an agent writes in a temp directory);
relative paths and writes remain constrained by
[`WorkspaceFileSystem.ts`](../../apps/server/src/workspace/WorkspaceFileSystem.ts).

Signed asset URLs are bearer credentials for a single canonical file, rechecked by device/inode
identity on serve ([`AssetAccess.ts`](../../apps/server/src/assets/AssetAccess.ts)). They never
grant access to sibling files, and because `filesystem:read` is checked only at mint time, an issued
URL remains valid until it expires even if the session or grant is revoked.
