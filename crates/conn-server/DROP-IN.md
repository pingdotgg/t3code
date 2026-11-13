# The Conn Server as a drop-in for the T3 server

What Orbit, Conn desktop and scripts do with the T3 server binary (`apps/server`), what the
Conn Server (`conn-server`) does in its place, and what stays open. Orbit references are to
`/Users/nckrtl/apps/orbit` at `origin/main` `77f6bf5c22` (2026-11-13). T3 references are to
this checkout.

## 1. Orbit Instance containers

| What                     | Orbit does                                                                                                                                                                                                                                                                                  | Reference                                                                                                                                                                        | Conn Server                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install                  | Native tarball `t3-0.1.7-linux-x64` (sha-pinned), unpacked into the agent folder, `bin/t3` symlinked; mounted read-only at `/opt/orbit-agent/current/agent/bin/t3`                                                                                                                          | `apps/gateway/resources/machine-software/recipe.json:1354-1365`, `swamp/ansible/tasks/instance-folder.yml:28-73`, `InstanceHostIntent.php:41`                                    | Same place, one static binary (`x86_64-unknown-linux-musl`)                                                                                                                                                                                                |
| Upgrade                  | Flip the `current` symlink, then `systemctl try-restart t3.service` per container                                                                                                                                                                                                           | `instance-folder.yml:141-168`                                                                                                                                                    | Same                                                                                                                                                                                                                                                       |
| Start                    | `ExecStart=/opt/orbit-agent/current/agent/bin/t3 serve --host=0.0.0.0 --port=3773 --no-browser`                                                                                                                                                                                             | `InstanceImage.php:179-212` (line 204)                                                                                                                                           | `serve`, `--host`, `--port`, `--no-browser`, `--flag=value` form: done                                                                                                                                                                                     |
| Unit                     | `User=agent`, `WorkingDirectory=/home/agent`, `HOME=/home/agent`, `PATH=…/agent/bin:…`, `DISABLE_AUTOUPDATER=1`, `EnvironmentFile=/home/agent/.config/orbit/model.env`, `Type=simple`, `Restart=always`, `RestartSec=2`, no stop settings (SIGTERM, then SIGKILL)                           | `InstanceImage.php:188-209`                                                                                                                                                      | Home from `$HOME` → `~/.t3/userdata`; stops on SIGTERM in under 2 s: done                                                                                                                                                                                  |
| Model access             | `model.env`: `ANTHROPIC_BASE_URL=http://<bridge>:8319`, `ANTHROPIC_AUTH_TOKEN`, `ORBIT_MODEL_KEY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`; Codex reads `~/.codex/config.toml` (provider `orbit`, `env_key=ORBIT_MODEL_KEY`)       | `InstanceContainer.php:252-259`                                                                                                                                                  | The server passes its environment to provider CLIs; no sign-in: done                                                                                                                                                                                       |
| Files Orbit writes first | `~/.t3/userdata/settings.json` = `{"linkedEnvironmentsEnabled": true}` (merged, only managed keys); `~/.claude.json`, `~/.codex/config.toml`, notes symlinks                                                                                                                                | `InstanceContainer.php:294-305`, `instance-container-phase.yml:819-840`                                                                                                          | `settings.json` read in the T3 format: done                                                                                                                                                                                                                |
| Readiness                | `curl --fail --max-time 2 http://127.0.0.1:3773/.well-known/t3/environment`, once a second for 30 s, else `instance.t3_unready`; read again at registration (needs string `environmentId`, `label`, `serverVersion`)                                                                        | `instance-container-phase.yml:866-881, 912`; `HttpT3ServerClient.php:28-41`                                                                                                      | Served without auth: done. No `/health` is used by Orbit                                                                                                                                                                                                   |
| Project                  | `t3 project add /srv/workspace --title <title>`; stdout kept as an existence mark                                                                                                                                                                                                           | `instance-container-phase.yml:884-900`                                                                                                                                           | `project add`: writes `projects.json`, prints `Added project <id> (<title>) at <root>.`, then asks the running server over `POST /api/projects/mutate`, which this server serves, so the project appears at once. |
| Sessions                 | `t3 auth session issue --label "Orbit Gateway"                                                                                                                                                                                                                                              | "Orbit Swamp" --token-only`(stdout = token), checked with`GET /api/auth/session`(needs`authenticated: true`, `scopes`, `expiresAt`; Gateway needs `access:read`, `access:write`) | `instance-container-phase.yml:915-931`                                                                                                                                                                                                                     | Done, while the server runs (shared `auth.json`) |
| Device pairing           | Swamp calls `POST <url>/api/auth/pairing-token` with the Gateway session and `{"label": "<node> via Orbit <rand>", "scopes": ["relay:read","access:read","access:write","relay:write"]}`; parses `id`, `credential`, `expiresAt`, echoed `label`; builds `<origin>/pair#token=<credential>` | `IssueConnPairingAction.php:26,44`, `workflow-operation-conn-pairing-create.yaml:76-93`, `conn-pairing/mod.ts`                                                                   | Scoped links with the label echoed: done                                                                                                                                                                                                                   |
| Revocation               | `POST /api/auth/clients/revoke`, `POST /api/auth/pairing-links/revoke`; `GET /api/auth/clients` for owner checks; `t3 auth session list --json` in fixtures                                                                                                                                 | `workflow-operation-conn-pairing-revoke.yaml:149,198`, `environmentHttp.ts`                                                                                                      | Done                                                                                                                                                                                                                                                       |
| Swamp driver             | `POST /mcp` (bearer); `POST /api/auth/websocket-ticket`, `/ws?orchestrationProtocol=2&wsTicket=…`; `orchestration.getThreadProjection`, `orchestration.forceStopThread`; MCP tools `t3_project_list`, `t3_thread_launch                                                                     | send                                                                                                                                                                             | wait                                                                                                                                                                                                                                                       | read`, `t3_pending_request`                      | `development-containers.md:892-909` | Tickets and `/ws`: done. `/mcp` is the MCP track; `forceStopThread` the engine track |
| Network                  | Binds `0.0.0.0:3773`; an Incus proxy device publishes `<wg ip>:<3800-3999>`; no reverse proxy, no path routing; clients reach the origin directly; nft admits only uid 0 and 2750                                                                                                           | `instance-container-phase.yml:139-146`, `InstanceContainer.php:51-53,210,332-342`, `InstanceImage.php:152`                                                                       | Nothing to change                                                                                                                                                                                                                                          |
| Logs                     | journald; T3 prints a pairing token at each start (journal readable by root and `agent`)                                                                                                                                                                                                    | `development-containers.md:834`                                                                                                                                                  | Prints `pairingUrl:` at each start: same exposure                                                                                                                                                                                                          |

Not used by Orbit: `T3CODE_*` variables, `--home-dir`, `environment link-orbit`, `t3 pair`,
static web files, cookies, DPoP. Orbit never renews the 30-day Gateway session
(`development-containers.md:832`).

**For Orbit to run the Conn Server it needs only a different binary in the agent folder.**
`/api/projects/mutate` and `/mcp` are served.

## 2. Conn desktop's local backend

| What       | Desktop does                                                                                                                                                                                                                                                                 | Reference                                                                                                               | Conn Server                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn      | `process.execPath` (Electron as Node) with `[--require <cache>] <server>/apps/server/dist/bin.mjs --bootstrap-fd 3`; env plus `ELECTRON_RUN_AS_NODE=1`, `T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING=1`, `T3CODE_CLI_PATH`; strips `T3CODE_PORT`, `T3CODE_MODE`, `T3CODE_HOST`, … | `apps/desktop/src/backend/DesktopBackendConfiguration.ts:487-551, 75-85`                                                | `--bootstrap-fd` and `T3CODE_BOOTSTRAP_FD`: done. The desktop must spawn a binary instead of Electron-as-Node (below)                                                      |
| Bootstrap  | One JSON line on fd 3 (`DesktopBackendBootstrap`): `mode: "desktop"`, `noBrowser`, `port`, `host`, `t3Home`, `desktopBootstrapToken`, `desktopBootstrapSecret?`, telemetry fds 4/5, browser fds 6/7, … Read within 1 s                                                       | `packages/contracts/src/desktopBootstrap.ts:10-34`, `apps/server/src/bootstrap.ts:74-146`                               | Reads `mode`, `port`, `host`, `t3Home`, token and secret (flags win; `t3Home` yields only to `--state-dir`/`--base-dir`): done. Fds 4–7 ignored                            |
| Credential | Token = hex HMAC-SHA256(secret, `t3-desktop-bootstrap:<12 h window>`), previous/current/next window valid; without a secret the token itself for 24 h; exchanged at `POST /oauth/token` (label "T3 Code Desktop", device `desktop`)                                          | `packages/shared/src/desktopBootstrapToken.ts`, `PairingGrantStore.ts:315-342`, `DesktopLocalEnvironmentAuth.ts:60-120` | Done; reusable, subject `desktop-bootstrap`; policy `desktop-managed-local` (`remote-reachable` with both methods on a LAN bind). Checked live: two exchanges on one token |
| Readiness  | `GET /.well-known/t3/environment`, every 100 ms, 3 min                                                                                                                                                                                                                       | `DesktopBackendManager.ts:346-367, 573-590`                                                                             | Done                                                                                                                                                                       |
| Stop       | SIGTERM, SIGKILL after 5 s; the server also exits when its parent changes (`launcherWatch.ts`, every 2 s)                                                                                                                                                                    | `DesktopBackendManager.ts:44-50`, `apps/server/src/launcherWatch.ts:13-36`                                              | Both: done                                                                                                                                                                 |
| Restart    | Backoff to 10 s; exit 78 = home owned by another server, no restart                                                                                                                                                                                                          | `DesktopBackendManager.ts:835, 905-910, 1016-1080`                                                                      | Same `server-owner.sqlite` lock; exits 78 when owned: done                                                                                                                 |

What the desktop still needs before it can run the Conn Server (not done, not tried):

- A spawn path for a native binary (no `ELECTRON_RUN_AS_NODE`, no `--require`), shipped per
  platform in the app bundle, and a setting or build flag that chooses it (section 6).
- The desktop telemetry and browser bridges (fds 4–7): the in-app browser, resource monitor
  and desktop telemetry go quiet. `server.commitDesktopUpdate` and the update flow are absent.
- Methods the desktop shell calls that other tracks own: terminals, files, VCS, previews.
- `T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING`: the T3 server reads the login shell's `PATH`
  before starting providers. The Conn Server uses its own environment as is.
- Windows: not built or tested (signals, `/dev/fd`, the ownership lock path all differ).

## 3. CLI subcommands scripts use

| T3 command                                                                                                                            | Conn Server                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `t3 serve [--host --port --base-dir --no-browser --mode --bootstrap-fd] [cwd]`                                                        | Done; `--tailscale-serve`, `--lan`, `--dev-url`, `--log-*` accepted and ignored                                                          |
| `t3 [cwd]` (web mode, opens a browser, bootstraps the cwd as a project)                                                               | The bare form serves the current folder as a project; no browser, no web files                                                           |
| `t3 pair [--scopes --ttl --label]`                                                                                                    | Done: finds the server through `server-runtime.json`, issues a link, prints `Pairing URL:`/`Token:`/`Expires:` (no QR code, no app link) |
| `t3 auth pairing create                                                                                                               | list                                                                                                                                     | revoke`, `t3 auth session issue | list    | revoke`                                                                           | Done with the same flags and output (`--json`, `--token-only`, `--base-url`) |
| `t3 project add <path> [--title]`                                                                                                     | Done (see section 1); `remove` and `rename` not built                                                                                    |
| `t3 environment link                                                                                                                  | link-orbit                                                                                                                               | list                            | unlink` | Not built: peer links need the engine's peer-link store. Orbit does not call them |
| `thread`, `up`, `status`, `connect`, `service`, `update`, `install`, `doctor`, `policy`, `theme`, `trace`, `triage`, `browser`, `app` | Not built; none is used by Orbit or the desktop                                                                                          |

Environment read: `T3CODE_HOME`, `T3CODE_PORT`, `T3CODE_HOST`, `T3CODE_MODE`,
`T3CODE_BOOTSTRAP_FD`; `CONN_SERVER_HOME` (the spike's) names a state directory when no
home is given. With no `--host` the Conn Server binds `127.0.0.1` (the T3 server binds every
interface in web mode); with no `--port` it takes the first free port from 3773, as T3 does.

## 4. Auth decisions

- **Cookie sessions and the web client's files: not built.** In a container nobody loads a page
  from the server's origin: devices pair through Conn's Connections (bearer token and
  WebSocket ticket), the Gateway and Swamp use bearer tokens, and Orbit routes no path to
  static files. Only `t3` on a user's own machine opening `http://localhost:3773` needs them
  (section 6c). Building them takes the web bundle (served from disk or embedded, ~10 MB),
  `POST /api/auth/browser-session`, an HttpOnly cookie per environment, and cookie auth on
  `/ws` and the HTTP routes. `tower-http`'s `ServeDir` would serve the files.
- **DPoP and the T3 Connect relay: not built.** DPoP is used only on the relay path: ES256
  proof verification (a P-256 crate), JWK thumbprints bound to tokens, replay markers, and
  `dpop-access-token` sessions. The relay itself is an outbound tunnel client to T3 Connect
  plus its enrolment methods (`cloud.*`, `relay:*` scopes). Several days of work, and Orbit
  routes over WireGuard instead. Token exchanges that carry a DPoP proof are refused before
  the code is spent, so a relay client fails clearly.
- **Lifetimes:** pairing links 5 min (startup link 24 h), sessions 30 days, tickets 5 min, as
  the T3 server. Revocation removes the session at once and closes its open sockets, also
  when the CLI revokes it from another process (seen within 30 s).
- **Scopes:** each RPC I registered checks the scope `RpcAuthorization.ts` names; failures are
  `EnvironmentAuthorizationError` with the legacy parent scope. The methods registered before
  this track still check none (the integrator should put the check in the method table).

## 5. State under `T3CODE_HOME`

The Conn Server keeps state in `<home>/userdata`, as the T3 server does, so one home serves
either server, never both at once.

| Path (`userdata/` unless noted)                                                                                                                                    | T3 server                                                                                                   | Conn Server                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment-id`                                                                                                                                                   | UUID + newline                                                                                              | **Reads it**; writes the same format. Clients keep recognising the environment                                                                                                          |
| `settings.json`                                                                                                                                                    | Sparse settings                                                                                             | **Reads and writes it** (same format, see `src/settings.rs`). Inline secrets: the Conn Server keeps them in the file (0600); the T3 server moves them to `secrets/` when it next starts |
| `keybindings.json`, `keybindings-migrations`                                                                                                                       | Rules, seeded with defaults                                                                                 | **Reads and writes both** (same format and backfill)                                                                                                                                    |
| `server-owner.sqlite`                                                                                                                                              | Ownership lock                                                                                              | **Takes the same lock**                                                                                                                                                                 |
| `server-runtime.json`                                                                                                                                              | Running server's origin                                                                                     | **Writes the same format**; T3's `t3 pair`/`project` CLI finds a running Conn Server                                                                                                    |
| `statev2.sqlite` (+ `-wal`/`-shm`), `state.sqlite`                                                                                                                 | Threads, projects, auth sessions and pairing links (`auth_sessions`, `auth_pairing_links`), everything else | **Ignored.** Threads need the migration below; T3 sessions are not carried over, so every device pairs again and Orbit issues new Gateway and Swamp sessions                            |
| `secrets/` (`server-signing-key.bin`, …)                                                                                                                           | Secret store, signing keys                                                                                  | Ignored                                                                                                                                                                                 |
| `attachments/`, `logs/`, `anonymous-id`, `themes/`, `browser-artifacts/`, `annotations/`, `speech/`, `providers/`, `model-manifest.json`, `usage-model-rates.json` | Feature data and caches                                                                                     | Ignored (other tracks may take attachments and logs)                                                                                                                                    |
| `<home>/worktrees`, `caches`, `runtime`, `tools`, `projects`, `scratch`                                                                                            | Worktrees, caches, managed tools                                                                            | Ignored                                                                                                                                                                                 |
| `engine.sqlite`, `auth.json`, `auth.lock`, `projects.json`                                                                                                         | —                                                                                                           | **Conn Server only**: event store, sessions and links, projects added with `project add`                                                                                                |

Switching back to the T3 server: settings, keybindings and the environment id carry over;
threads and pairings made on the Conn Server do not.

**Thread-history migration (design only).** A one-shot `conn-server migrate-t3` with both
servers stopped: open `statev2.sqlite` read-only, read the projection rows (projects, threads,
turns, messages, turn items, runs) rather than replaying T3's event log, and append one
`thread.imported`-style event per thread into `engine.sqlite` carrying the projection as the
client contract encodes it, so the Conn Server's own projections rebuild from its own log.
Keep T3 ids, so clients' cached links survive. Skip live state: running turns become stopped,
provider sessions are not resumed (the provider resumes by its own session id on the next
turn). Checkpoint refs live in git and need nothing. Record the source commit and row counts
in a marker table so the import never runs twice, and prove it with a recording of a migrated
home in the real client.

## 6. Making the Conn Server the default

The T3 server (`apps/server`) stays as upstream has it. The Conn Server becomes the default
place by place; each place keeps a way back.

**(a) Orbit containers.** Ready when: `/mcp` serves Swamp's tools; `project add` reaches the
running server; `forceStopThread` and the thread methods Swamp uses work; the Codex provider
works through the AI router; a container has run a week of real use with the client showing
no "not supported" error on the paths users take; memory is measured in the container.
**Selection:** the agent bundle's `bin/t3` points at `conn-server` instead of the T3 tarball
(the recipe's `instances.agent.t3` entry). Orbit needs no other change; rolling back is the
recipe entry again. Moving an existing container keeps its settings and identity but not its
threads or pairings (section 5) until the migration exists.

**(b) Conn desktop's local backend.** Ready when: everything a desktop user reaches from the
chat view and Settings works (terminals, files, VCS, diffs, previews, attachments); the
desktop's fds 4–7 bridges or their replacement; the update flow; signed binaries for macOS
arm64/x64, Linux and Windows in the app bundle. **Selection:** a desktop setting ("Local
server: Conn Server / T3 server"), read before spawning, choosing the binary and dropping
`ELECTRON_RUN_AS_NODE`; the T3 server stays bundled as the fallback. The home is shared, so
switching is a restart; the ownership lock prevents both running.

**(c) A user's own machine (`t3` / `conn-server` in a terminal, a service).** Ready when:
everything in (b), plus serving the web client from the server's origin with cookie sessions
(section 4), the `t3 service` install flow, and update checks. **Selection:** the command the
user runs (`conn-server serve`) or the service unit's `ExecStart`; a later installer could
offer the choice.

## 7. A separate repository

The Conn Server moves to its own repository, `conn-server`. For delivery:

- **Release artifacts per target.** CI builds `conn-server-<version>-<target>.tar.gz` for
  `x86_64-unknown-linux-musl` (Orbit), `aarch64-unknown-linux-musl`, `aarch64-apple-darwin`,
  `x86_64-apple-darwin` and later Windows, each with a sha256. Orbit's recipe pins one URL
  and sha, exactly as it pins the T3 tarball today, and maps `bin/t3` to it. Conn desktop's
  build downloads the pinned artifact per platform into the app bundle and signs it with the
  app.
- **Version reporting.** `conn-server --version` prints its own version, the T3 server
  version whose contract it speaks, and the Conn commit the contract came from
  (`conn-server 0.1.0 (T3 server 0.1.9 contract, Conn commit 415dd48…)`). Release notes name
  the same three.
- **The contract commit.** `crates/conn-contract/methods.json` pins the Conn commit whose
  `packages/contracts` generated the types; `gen-contract.mjs --check` against a Conn
  checkout (`CONN_MONOREPO`) shows when Conn's contract moved. A Conn release that changes the
  contract needs a Conn Server release built from it before Orbit or the desktop takes both.
- **Which server a client talks to.** The descriptor (`/.well-known/t3/environment`) stays
  T3's: `serverVersion` is the T3 version whose contract is served, so clients' version checks
  behave. `GET /health` answers only on the Conn Server, with
  `{"server":"conn-server","version","contractCommit","methods"}`; the T3 server has no such
  route. A typed field (for example `serverImplementation` in the descriptor) would need a
  contract change in Conn first.
- **Tools that need Conn.** `tools/gen-keybindings.mjs`, `fixtures/recorder` and the other
  Node tools read the monorepo from `$CONN_MONOREPO`. There is no default
  (`tools/monorepo.mjs` at the repository root).
