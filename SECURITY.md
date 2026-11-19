# Security

Report vulnerabilities to [security@t3.codes](mailto:security@t3.codes). The
[security policy](.github/SECURITY.md) covers disclosure and safe harbor.

The rest of this file is for agents and maintainers auditing T3 Code or triaging
a report. It says who is trusted with what, which boundaries a real finding
crosses, and what is intended. The reasoning behind each boundary lives in
[environment auth](docs/internals/environment-auth.md),
[T3 Connect](docs/internals/t3-connect.md), and
[remote environments](docs/internals/remote.md). Read those before you report a
finding in their area.

## The model in one paragraph

An environment is a T3 server running as an OS user. It is not a sandbox: it
runs agents and terminals with that user's privileges, on purpose. Clients get
authority by pairing, which issues a scoped session. A full-scope session is
equivalent to a shell as the server's user, because `terminal:operate` opens a
PTY and `orchestration:operate` can start a full-access agent. Security work
here is about who can get a session, what each kind of session can reach, and
whether revocation and ceilings hold. It is not about what a full session can do
once it has one.

## What each scope really grants

A scope's name says what it is for, not how far it reaches. Rank a finding,
and choose scopes for a narrow pairing link, by the tier below. Any code
execution is the top tier: a shell can run `t3 auth session issue` and mint
every scope.

**Tier 1: code execution as the server's user.**

- `terminal:operate`: opens a shell.
- `orchestration:operate`: starts a turn in full access. Under a managed
  `approval-required` ceiling the same client approves its own requests.
  Launching a worktree thread runs the configured setup scripts with no mode
  check.
- `settings:write`: sets `defaultProjectScripts`, which the next worktree
  launch runs. It takes effect later, not immediately.
- `providers:manage`: sets a provider's binary path and environment, which run
  on the next turn or provider check.
- `filesystem:write`: writes project files that tools run later, such as
  `.claude/settings.json` hooks (run on the next Claude turn), `package.json`
  scripts and `.envrc`. `.git` is refused.

**Tier 2: credentials or reach beyond this environment.**

- `filesystem:read`: every file the user can read, including SSH keys,
  provider logins, forge tokens, terminal logs and traces. Only this server's
  own `secrets` and database are refused. Another T3 home on the same machine
  is readable.
- `source-control:write`: pushes, merges and comments with the stored forge
  credentials.
- `access:write`: creates pairing links within its own scopes, but revokes any
  session and approves Connect devices to a full grant.
- `preview:operate`: the server-side browser loads any http(s) URL, including
  loopback and LAN services, and streams the page back.
- `environment:maintain`: installs any published version, including older
  ones, and restarts the server.

**Tier 3: reads that may contain secrets.**

- `orchestration:read`: every transcript and diff, and anything agents printed.
  Settings come back with secret fields redacted.
- `terminal:read`: the scrollback of every terminal.
- `diagnostics:read`: traces and the process list.
- `access:read`, `relay:read`: metadata only.
- `relay:write`: installs the pinned tunnel client. It takes no input.

## Principals

| Principal                                                                                        | How it gets in                              | What it may do                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anyone who reaches the port                                                                      | Network                                     | Read the environment descriptor, pair with a valid one-time credential, run OAuth flows. Nothing else.                                                                                     |
| Full-scope client (desktop, paired browser or phone, `t3 auth session issue`, T3 Connect device) | Pairing, token exchange, Connect mint       | Everything the server's OS user can do. This is the default grant.                                                                                                                         |
| Narrow client                                                                                    | Pairing link with explicit scopes           | Only the RPCs and routes its scopes allow. Can never widen its own grant.                                                                                                                  |
| MCP client (outside agent, subject `mcp-client`)                                                 | OAuth on `/mcp`                             | Only `/mcp`, within a read-only grant or a runtime-mode ceiling. Every other route rejects it.                                                                                             |
| Linked environment (peer link)                                                                   | OAuth client `t3code-peer-link`             | Work it starts carries an immutable `linkOrigin` and never exceeds the access it was paired with.                                                                                          |
| Agent run by T3                                                                                  | Thread's runtime mode and thread credential | Within its runtime mode, managed policy, and the MCP access declared per tool.                                                                                                             |
| Guest link                                                                                       | HMAC token for one share                    | Read one thread and propose messages. Never a session; no RPC, WebSocket, or MCP path accepts it.                                                                                          |
| Signed asset URL                                                                                 | Minted with `filesystem:read`               | One file, by device and inode identity, until it expires.                                                                                                                                  |
| T3 Connect relay                                                                                 | Environment link                            | Trusted broker for mint requests. It never sees environment session tokens. With `requireConnectDeviceApproval` on, a new device key also needs approval from someone with `access:write`. |
| Managed policy                                                                                   | Admin-deployed file, read at startup        | Ceilings and locks the server enforces for every client.                                                                                                                                   |
| Preview pages, HTML renders, file previews, agent output                                         | Rendered by clients                         | Untrusted content. It must never run script in the app's origin or reach Electron IPC or Node.                                                                                             |

## A real finding crosses one of these

1. **No credential → session.** Any route or socket that grants access without
   a valid credential, or a pairing credential that can be redeemed twice.
2. **Scope escalation.** An RPC, HTTP route, or MCP tool that runs without the
   scope it declares; pairing or token exchange that widens a grant; an
   `mcp-client` session reaching a non-`/mcp` route; a read-only MCP grant
   calling a write tool.
3. **Mode or policy escalation.** An agent, MCP client, or peer link acting
   above its runtime-mode ceiling, `linkOrigin`, `T3-Mode-Limit`, or managed
   policy.
4. **Guest escape.** A guest token reading another thread, acting beyond
   proposing messages, or surviving a closed or replaced share.
5. **Revocation that doesn't take effect.** A revoked session, device key,
   pairing link, or peer link that still works. The exception is documented:
   signed asset URLs last until they expire.
6. **Credential exposure.** Tokens or secrets reaching logs, traces, telemetry,
   the relay, socket URLs (outside short-lived tickets), the access read model,
   or error messages. A token sent to an address that has not answered as the
   expected environment. A token paired over HTTPS starting to travel over plain
   HTTP.
7. **Impersonation and egress.** Another process or the relay impersonating an
   environment, or endpoint discovery, previews, or webhooks used to reach
   arbitrary hosts (SSRF).
8. **Client-side code execution.** Untrusted content running script in the web
   origin, the desktop renderer, or with access to preload or IPC.
9. **Filesystem writes escaping workspace path rules.** Reads are another
   matter: `filesystem:read` is intentionally the whole account.

## Intended, not vulnerabilities

- A full-scope token gives a shell. Leaking one is serious, but the bug is the
  leak, not the shell.
- The default grant includes `access:write`, so a full session can mint more
  pairing links and sessions. They appear in Sharing & access, and "revoke all
  others" removes them.
- `filesystem:read` reads anything the server's user can read, including paths
  outside projects.
- Plain HTTP on a LAN or tailnet is the user's choice. `t3 serve` warns when it
  advertises a non-loopback HTTP address. The iOS app allows arbitrary loads so
  it can reach these addresses.
- `access-control-allow-origin: *` on the environment API. Auth is a bearer
  header, so the wildcard grants nothing a caller without a token lacks.
- An agent in full-access mode can do whatever the user can. Prompt injection
  that stays within the agent's mode is the provider's concern. One that lets
  it act above that mode is in scope (see 3).
- A compromised relay signing key can mint for linked environments. That is
  the stated trust assumption; device approval is the mitigation.
- `T3CODE_DEV_AUTH_TOKEN` and dev startup URLs are administrative by design and
  ignored outside development servers.
- An attacker already running code as the same OS user.

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
- Check the reported commit against `main`. Reports often trail fixes.
- Prove a finding with a failing test at the lowest layer that shows it, as
  [Verifying](AGENTS.md#verifying) describes. Do not run a PoC against
  `~/.t3/userdata` or any live environment. Use a dev server on seeded data.
- Treat report attachments as untrusted. Extract them into an empty directory
  outside the worktree and read PoCs before running anything.
- Fix confirmed findings rather than filing them. Keep advisory details out of
  public PRs until the fix ships.
- When a boundary here changes, update this file and the internal doc that
  explains it in the same PR.
