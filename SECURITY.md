# Security

Report vulnerabilities to [security@t3.codes](mailto:security@t3.codes). The
[security policy](.github/SECURITY.md) covers disclosure and safe harbor.

The rest of this file is for agents and maintainers auditing T3 Code or triaging
reports. It defines who is trusted with what, which boundaries a real finding
crosses, and what is intended. The reasoning behind each boundary lives in
[environment auth](docs/internals/04_environment-auth.md),
[T3 Connect](docs/internals/06_t3-connect.md), and
[remote environments](docs/internals/05_remote.md); read those before reporting
in their area.

## The model in one paragraph

An environment is a T3 server running as an OS user. It is not a sandbox: it
intentionally runs agents and terminals with that user's privileges. Clients
gain authority by pairing, which issues a scoped session. A full-scope session
equals a shell as the server's OS user, because `terminal:operate` opens a PTY
and `orchestration:operate` can start a full-access agent. Security here is
about who can obtain a session, what each session type can reach, and whether
revocation and ceilings hold—not what a full-scope session can do once issued.

## Principals

| Principal                                                                                        | How it gets in                                        | What it may do                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone who reaches the port                                                                      | Network                                               | Read the environment descriptor, pair with a valid one-time credential, run OAuth flows. Nothing else.                                                                                   |
| Full-scope client (desktop, paired browser or phone, `t3 auth session issue`, T3 Connect device) | Pairing, token exchange, Connect mint                 | Everything the server's OS user can do (the default grant).                                                                                                                              |
| Narrow client                                                                                    | Pairing link with explicit scopes                     | Only the RPCs and routes its scopes allow. Can never widen its own grant.                                                                                                                |
| MCP client (outside agent, subject `mcp-client`)                                                 | OAuth on `/mcp`                                       | Only `/mcp`, within a read-only grant or a runtime-mode ceiling. Every other route rejects it.                                                                                           |
| Linked environment (peer link)                                                                   | OAuth client `t3code-peer-link`                       | Started work carries an immutable `linkOrigin` and never exceeds its paired access.                                                                                                      |
| Agent run by T3                                                                                  | Thread's runtime mode and thread credential           | Within its runtime mode, managed policy, and the MCP access declared per tool.                                                                                                           |
| Guest link                                                                                       | HMAC token for one share                              | Read one thread and propose messages. Never a session; no RPC, WebSocket, or MCP path accepts it.                                                                                        |
| Signed asset URL                                                                                 | Minted with `filesystem:read`                         | One file, by device and inode identity, until it expires.                                                                                                                                |
| Webhook sender                                                                                   | Task's webhook URL, plus signing secret when required | Start that one task's run with chosen content. Nothing in the request is trusted beyond the signature check.                                                                             |
| T3 Connect relay                                                                                 | Environment link                                      | Trusted broker for mint requests; never sees environment session tokens. With `requireConnectDeviceApproval` on, a new device key also needs approval from a caller with `access:write`. |
| Managed policy                                                                                   | Admin-deployed file, read at startup                  | Ceilings and locks the server enforces for every client.                                                                                                                                 |
| Preview pages, HTML renders, file previews, agent output                                         | Rendered by clients                                   | Untrusted content. Must never run script in the app's origin or reach Electron IPC or Node.                                                                                              |

## A real finding crosses one of these

1. **No credential → session.** Any route or socket that grants access without
   a valid credential, or a pairing credential redeemable twice.
2. **Scope escalation.** An RPC, HTTP route, or MCP tool running without its
   declared scope; pairing or token exchange that widens a grant; an
   `mcp-client` session reaching a non-`/mcp` route; a read-only MCP grant
   calling a write tool.
3. **Mode or policy escalation.** An agent, MCP client, or peer link acting
   above its runtime-mode ceiling, `linkOrigin`, `T3-Mode-Limit`, or managed
   policy.
4. **Guest escape.** A guest token reading another thread, acting beyond
   proposing messages, or surviving a closed or replaced share.
5. **Revocation that doesn't take effect.** A revoked session, device key,
   pairing link, or peer link that still works. Documented exception: signed
   asset URLs last until they expire.
6. **Credential exposure.** Tokens or secrets reaching logs, traces, telemetry,
   the relay, socket URLs (outside short-lived tickets), the access read model,
   or error messages. A token sent to an address that has not answered as the
   expected environment, or a token paired over HTTPS sent over plain HTTP.
7. **Impersonation and egress.** Another process or the relay impersonating an
   environment, or endpoint discovery, previews, or webhooks used to reach
   arbitrary hosts (SSRF).
8. **Client-side code execution.** Untrusted content running script in the web
   origin, the desktop renderer, or with access to preload or IPC.
9. **Filesystem writes escaping workspace path rules.** Reads are separate:
   `filesystem:read` intentionally covers the whole account.

## Intended, not vulnerabilities

- A full-scope session gives a shell. Leaking its token is serious, but the bug
  is the leak, not the shell. A narrow session holding `terminal:operate` or
  `orchestration:operate` is in the same position: reaching via another route
  what its shell can already do crosses no boundary, though it can still be an
  ordinary bug. That stops at what a shell as the server's OS user cannot reach:
  another client's device, what another scope guards by name (as
  `providers:manage` does for secret references), a managed-policy ceiling or
  lock, and access that outlives revocation.
- The default grant includes `access:write`, so a full-scope session can mint
  more pairing links and sessions. They appear in Sharing & access, and "revoke
  all others" removes them.
- `filesystem:read` reads anything the server's OS user can read, including
  paths outside projects.
- Plain HTTP on a LAN or tailnet is the user's choice. `t3 serve` warns when it
  advertises a non-loopback HTTP address. The iOS app allows arbitrary loads so
  it can reach these addresses.
- `access-control-allow-origin: *` on the environment API. Auth is a bearer
  header, so the wildcard grants nothing a caller without a token lacks.
- A full-access agent can do whatever the user can. Prompt injection that stays
  within an agent's mode is the provider's concern; one that lets it act above
  that mode is in scope (see 3).
- A compromised relay signing key can mint for linked environments. That is
  the stated trust assumption; device approval is the mitigation.
- `T3CODE_DEV_AUTH_TOKEN` and dev startup URLs are administrative by design and
  ignored outside development servers.
- A webhook URL is a credential for one task. Unless the task requires a
  signature, any holder can start that task's run with request content of their
  choosing, within the route's limits. It is a finding when a request starts a
  different task, runs without a required signature, or has its values treated
  as trusted data. Tokens in or around the request remain covered by 6.
- The machine owner's own configuration. Whoever sets a provider's launch
  arguments, an environment variable, a binary path, or the endpoint or file T3
  Code points at already holds the OS account, so weakening their own setup is
  their choice. It is a finding when a narrower principal (a narrow client, an
  MCP client, an agent below full access, or repository content) can set it,
  when [managed policy](docs/user/managed-policy.md) locks the setting and the
  value still applies, or when the value leaks (see 6). Choosing a host does
  not make it trusted: what a configured endpoint can do to the server or its
  clients stays in scope.
- An attacker already running code as the same OS user, including one who
  rewrites files that user owns outside a workspace (T3 Code's data directory,
  its installed helpers, the user's own config). Another OS account on the same
  machine is not this attacker; neither is repository content or an agent below
  full access, which write inside a workspace without holding the OS account.

## Where enforcement lives

- Session issuance, pairing, token exchange: [`auth/http.ts`](apps/server/src/auth/http.ts), [`auth/EnvironmentAuth.ts`](apps/server/src/auth/EnvironmentAuth.ts), [`auth/dpop.ts`](apps/server/src/auth/dpop.ts)
- Per-RPC scopes: [`auth/RpcAuthorization.ts`](apps/server/src/auth/RpcAuthorization.ts). [`clientRpcPermissions.ts`](packages/contracts/src/clientRpcPermissions.ts) only drives client UI and is never the boundary.
- MCP: [`auth/McpOAuth.ts`](apps/server/src/auth/McpOAuth.ts), [`mcp/McpToolAccess.ts`](apps/server/src/mcp/McpToolAccess.ts), [`mcp/threadAccess.ts`](apps/server/src/mcp/threadAccess.ts), [`mcp/linkOrigin.ts`](apps/server/src/mcp/linkOrigin.ts)
- Guest links: [`guest/GuestShareService.ts`](apps/server/src/guest/GuestShareService.ts)
- Files and assets: [`workspace/WorkspaceFileSystem.ts`](apps/server/src/workspace/WorkspaceFileSystem.ts), [`assets/AssetAccess.ts`](apps/server/src/assets/AssetAccess.ts)
- Managed policy: [`apps/server/src/policy`](apps/server/src/policy)
- T3 Connect: [`cloud/CloudLink.ts`](apps/server/src/cloud/CloudLink.ts), [`EnvironmentConnector.ts`](infra/relay/src/environments/EnvironmentConnector.ts)
- Desktop preview isolation: [`preview/WebviewPreferences.ts`](apps/desktop/src/preview/WebviewPreferences.ts)

## How to audit and triage

- Name the precondition first. If a chain starts with "the attacker holds a
  full-scope token", it is a new vulnerability only if it widens that token's
  reach (2–3), outlives revocation (5), or shows how the token leaks (6).
- Name the actor next and what they can already do. If the only actor is the
  user on their own device, or a principal reaching the same outcome via a
  documented route, no boundary is crossed unless data goes somewhere they did
  not send it. It may still be a bug; report it as one.
- Read tests and comments beside the code before calling a behavior a defect. A
  test asserting it by name or a comment explaining why makes it a decision;
  report it only if it breaks a documented promise or crosses a boundary above.
- Follow the claim to its effect. A guard in a caller, a schema, or a version
  check elsewhere often means the cited lines cannot do what the report says.
- Check the reported commit against `main`. Reports often trail fixes.
- Prove a finding with a failing test at the lowest layer that shows it (see
  [Verifying](AGENTS.md#verifying)). Do not run a PoC against `~/.t3/userdata`
  or any live environment; use a dev server on seeded data.
- Treat report attachments as untrusted. Extract them into an empty directory
  outside the worktree and read PoCs before running anything.
- Fix confirmed findings rather than filing them. Keep advisory details out of
  public PRs until the fix ships.
- When a boundary changes, update this file and its internal doc in the same PR.
