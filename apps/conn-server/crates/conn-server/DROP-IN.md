# The Conn Server as a drop-in for the T3 server

What Orbit, Conn desktop and scripts do with the T3 server binary (`apps/server`), what the
Conn Server (`conn-server`) does in its place, and what stays open. Orbit references are to
`/Users/nckrtl/apps/orbit` at `origin/main` `77f6bf5c22` (2026-11-13). T3 references are to
this checkout.

## 1. Orbit Instance containers

| What                     | Orbit does                                                                                                                                                                                                                                                                                  | Reference                                                                                                                                                                        | Conn Server                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install                  | Native tarball `t3-0.1.7-linux-x64` (sha-pinned), unpacked into the agent folder, `bin/t3` symlinked; mounted read-only at `/opt/orbit-agent/current/agent/bin/t3`                                                                                                                          | `apps/gateway/resources/machine-software/recipe.json:1354-1365`, `swamp/ansible/tasks/instance-folder.yml:28-73`, `InstanceHostIntent.php:41`                                    | Same place: the release tarball (see "Release tarball for Orbit")                                                                                                                                                                                      |
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
| Swamp driver             | `POST /mcp` (bearer); `POST /api/auth/websocket-ticket`, `/ws?orchestrationProtocol=2&wsTicket=…`; `orchestration.getThreadProjection`, `orchestration.forceStopThread`; MCP tools `conn_project_list`, `conn_thread_launch                                                                     | send                                                                                                                                                                             | wait                                                                                                                                                                                                                                                       | read`, `conn_pending_request`                      | `development-containers.md:892-909` | Tickets and `/ws`: done. `/mcp` is the MCP track; `forceStopThread` the engine track |
| Network                  | Binds `0.0.0.0:3773`; an Incus proxy device publishes `<wg ip>:<3800-3999>`; no reverse proxy, no path routing; clients reach the origin directly; nft admits only uid 0 and 2750                                                                                                           | `instance-container-phase.yml:139-146`, `InstanceContainer.php:51-53,210,332-342`, `InstanceImage.php:152`                                                                       | Nothing to change                                                                                                                                                                                                                                          |
| Logs                     | journald; T3 prints a pairing token at each start (journal readable by root and `agent`)                                                                                                                                                                                                    | `development-containers.md:834`                                                                                                                                                  | Prints `pairingUrl:` at each start: same exposure                                                                                                                                                                                                          |

Not used by Orbit: `T3CODE_*` variables, `--home-dir`, `environment link-orbit`, `t3 pair`,
static web files, cookies, DPoP. Orbit never renews the 30-day Gateway session
(`development-containers.md:832`).

### Task turns (2026-11-14)

Orbit's task-turn path (`swamp/ansible/task-copy-turn.yml` and `t3_copy_rpc.mjs` at Orbit
`main` `569302a`, 2026-11-14) runs `t3` and Node in the container as `agent`, with `HOME=/home/agent`.
Every item is built. `thread-cli-diff.mjs` runs the same commands on the T3 server with its own
`t3` and on this server with ours and finds no difference (30 steps); `orbit-flow.mjs` runs the
path in Orbit's order on the fake provider.

| What | Orbit does | Reference | Conn Server |
| --- | --- | --- | --- |
| Model check | `cat ~/.t3/userdata/settings.json` and `model-manifest.json`; the driver's `manifest.providers[driver].models[].slug` and `aliases` must hold `--model`; no file, no check | `task-copy-turn.yml:68-133` | Writes `model-manifest.json` as T3's `ModelManifest.ts`: fetched from T3 Code's GitHub at most hourly while `enableProviderUpdateChecks` is on, `{"fetchedAtMs","manifest"}` (section 5) |
| Settle, continue, read | `t3 thread list --project /srv/workspace --json`; finds threads by `title`, reads `threadId` and `status` | `:147, 251, 466` | Done |
| The turn | `t3 thread start --provider P --model M --title T --wait --json /srv/workspace -` or `t3 thread send --wait --json <thread> -`, prompt on stdin, under `timeout --kill-after=30 <seconds>`; exit 0 done, 1 failed, 2 waits for an answer; stdout `{"threadId","runId","status","reply","error"}`, stderr kept on failure | `:376-402` | Done, same output, texts and exit codes |
| Read back | `t3 thread show --messages 200 --json <thread>` | `:480` | Done |
| A run that asks | `node - t3 read <thread>`, then `node - t3 interrupt <thread> <run> <request ids>` (`t3_copy_rpc.mjs`): `server-runtime.json`, `t3 auth session issue --scope orchestration:read [--scope orchestration:operate] --ttl 1m --label "orbit copy turn" --json`, `POST /api/auth/websocket-ticket`, `/ws`, `orchestration.getThreadProjection`, `orchestration.dispatchCommand {run.interrupt}`, `t3 auth session revoke <sessionId>` | `:406-461`; `t3_copy_rpc.mjs:30-145` | Done; the read, the interrupt and the revoke run in `thread-cli-diff.mjs` on both servers |

How the `thread` commands reach the server, in both CLIs: read `userdata/server-runtime.json`
(the origin, and a live `pid`), issue a session straight into the auth store (T3: an MCP client
session, 30 days, scopes `orchestration:read`, `orchestration:operate`, `settings:write`,
`source-control:write`, label `t3 thread cli`), call `/mcp` with it, revoke it when the command
ends. No token from outside is needed; whoever may write the auth store may run them.

### Release tarball for Orbit (2026-11-15)

Nick decided on 2026-11-15 that an Orbit Project chooses the T3 server or the Conn Server for
its containers. Only the binary differs; credentials stay as with T3 (`model.env`, Codex's
`config.toml`, through the AI router).

**Build.** `node tools/release-tarball.mjs [--out <dir>]` on Linux x86_64 (needs `musl-gcc`
and GNU tar). It writes `conn-server-<version>-linux-x64.tar.gz` and `<tarball>.sha256`, and
prints the sha256. The version is `[workspace.package]` in `Cargo.toml`. Same input, same bytes.

```text
conn-server-<version>-linux-x64/
├── conn-server          x86_64-unknown-linux-musl, static
└── sdk-host/            index.mjs, drivers/, package.json, package-lock.json, .npmrc
    └── node_modules/    @anthropic-ai/claude-agent-sdk only (npm ci --omit=dev --ignore-scripts)
```

**Release.** `.github/workflows/conn-server-release.yml` in the Conn monorepo
(`nckrtl/conn`, public) builds it on `ubuntu-24.04` when a tag `conn-server-v*` is pushed.
The tag must be `conn-server-v` plus the `conn-server` crate version. The run makes a GitHub
Release on `nckrtl/conn` with the tarball and its `.sha256`, not marked Latest.
`workflow_dispatch` on a branch only keeps the tarball as a workflow artifact. No tag has been
pushed and no release made yet.

**How the server finds the SDK host.** Orbit links `bin/conn-server` to
`../conn-server/conn-server-<version>-linux-x64/conn-server`. The server follows that link
and looks beside the real binary: `conn-sdk-host` (the single executable) first, then
`sdk-host/index.mjs`, which it runs with `node` from `PATH`. `--sdk-host` and `CONN_SDK_HOST`
still win. The `node` is Orbit's runtime folder's (`/opt/orbit-runtime/current/bin/node`,
Node 24.22.1); the agent folder has none.

**Recipe entry Orbit would add** (`apps/gateway/resources/machine-software/recipe.json`,
`instances.agent`), beside `t3`:

```json
"conn-server": {
    "version": "0.1.0",
    "artifacts": {
        "amd64": {
            "url": "https://github.com/nckrtl/conn/releases/download/conn-server-v0.1.0/conn-server-0.1.0-linux-x64.tar.gz",
            "sha256": "<the .sha256 of the release>"
        }
    },
    "bin": {
        "conn-server": "conn-server-0.1.0-linux-x64/conn-server"
    }
}
```

A Project that chooses the Conn Server then gets `ExecStart=/opt/orbit-agent/current/agent/bin/conn-server
serve --host=0.0.0.0 --port=3773 --no-browser` in `t3.service`, and Orbit's `t3 ...` CLI calls
become `conn-server ...`. The Orbit side of the choice is not built.

**Node.** The SDK host asks for Node 24.10 or newer (`engines`); the Claude Agent SDK 0.3.321
asks for 18.14. The T3 server allows `^22.16 || ^23.11 || >=24.10` (`apps/server/package.json`),
but its release `t3-0.1.7-linux-x64` embeds Node 26.12.1 and runs the SDK there. In Orbit the
Conn Server runs the SDK on the runtime folder's Node 24.22.1. CI and the checks run the SDK
host on 26.12.1. The SDK gives the `claude` CLI the same argv on 24.22.1 (proof below); a
difference between the two Node versions in a live turn is not tested. If Orbit's runtime
Node falls below 24.10, the SDK host may not start.

**Proof on Beast (2026-11-15)**, in the `conn-proof` container of the Incus project
`conn-server-proof` (Orbit's Instance image), no model and no credential. The tarball was
built on Beast (`tools/release-tarball.mjs`, 10,131,239 bytes, sha256
`b94b2054c3aeac93ed83170760e2b0d4b3c8cdebe6a0a9f163982eafc4f2e3ca`; a second pack gave the
same bytes). The script is `/tmp/conn-release-proof/proof.sh` in the container.

1. Orbit's folder steps: `tar -xf --no-same-owner` into `agent/conn-server`, the `bin` link,
   the check for an executable regular file, `root:root` and `u+rwX,go+rX,go-w`, then
   `root:2750` and `o-rwx` on `agent/`. Passed.
2. As `agent` with Orbit's `PATH` order: `conn-server --version` runs; `node` is the runtime
   folder's v24.22.1.
3. The bundled SDK host under that node, as `agent`: `{"ch":"host","t":"ready","protocol":1,"node":"24.22.1"}`, exit 0.
4. `conn-server serve` as `agent` became ready (`/.well-known/t3/environment` answered). Its
   Claude status probe started the SDK host from the tarball, which loaded the SDK and
   started the stub `claude` with the SDK's argv (`--output-format stream-json --verbose
   --input-format stream-json ...`, `CLAUDE_CODE_ENTRYPOINT=t3-code`). The stub's parent was
   `node .../conn-server-0.1.0-linux-x64/sdk-host/index.mjs` with exe
   `/opt/orbit-runtime/<version>/node/node-v24.22.1-linux-x64/bin/node`; its parent was
   `conn-server`. The stub exits 1, so the probe reports an error; no model was called. The
   SDK host was gone after the probe. SIGTERM stopped the server and closed the port.

Not proven: a live turn through the tarball, Codex from the tarball (it needs no SDK host),
the release workflow itself (it has not run), and the server under Orbit's real
`t3.service` with this layout (the earlier proof ran an older binary as `bin/t3`).

### macOS app bundle (2026-11-23)

On a Mac the server runs as `Conn Server.app` (`com.nckrtl.conn-server`, `LSUIElement`), not
as a bare executable. `tools/macos-app.sh --from <folder with conn-server and sdk-host/> --out
<dir>` builds it: the binary in `Contents/MacOS`, `sdk-host/` and Conn's icon in
`Contents/Resources`, signed with Developer ID and the hardened runtime.

**Where it comes from.** Each `conn-server-v*` release ships it as
`conn-server-<version>-macos-arm64.zip` (with a `.sha256`), beside the Linux tarball. The
`macos` job of `.github/workflows/conn-server-release.yml` builds it on the self-hosted runner on
mini (label `conn-mac-release`, whose login keychain holds the identity):
`tools/release-tarball.mjs --platform macos-arm64` makes the folder, `macos-app.sh` signs it,
and the job checks the team id before it zips the bundle with `ditto`. To build one by hand on
an arm64 Mac, run the same two commands.

**Why.** For a bare executable TCC keys a grant by its path (`client_type` 1 in `TCC.db`), so
each new install path asked again and listed one more nameless entry without an icon. Screen
capture comes from the server's children, not from the server: agents run `screencapture`, and
the Device panel's serve-sim stream loads LiveKit's WebRTC framework, which links ScreenCaptureKit
and `CGDisplayStream`. The prompts named "conn-server", which suggests, but does not prove, that
macOS charged those children to the launchd process.

**Not yet proven.** Two things are open until a test with real prompts passes:

- *Attribution:* that a child's Screen Recording or Accessibility request is charged to the
  bundle (`com.nckrtl.conn-server`, its name and icon) when launchd runs the bundle's Mach-O
  directly, not through LaunchServices.
- *Persistence:* that TCC keys that grant by bundle id and team, and keeps it when the bundle is
  replaced by a rebuild with the same designated requirement.

The test is a disposable GUI LaunchAgent whose children ask for Screen Recording and
Accessibility, then a rebuilt bundle at the same and at another path. A pass covers only those
two services and those requests. It says nothing yet about Files and Folders, Automation or the
serve-sim stream; claim those only after a test of each.

**Install.** Keep the bundle at one path (`~/Applications/Conn Server.app`) and replace it in
place on updates. The launchd job runs `Contents/MacOS/conn-server` and sets
`AssociatedBundleIdentifiers` to `com.nckrtl.conn-server`, which Apple documents for Login Items
attribution; whether it changes TCC attribution is part of the test above. On macOS only, the
server finds the SDK host in `Contents/Resources` inside a `.app`, after the folder beside the
binary. `CFBundleVersion` must be a build number that `CFBundleGetVersionNumber` can parse; the
packager checks that before signing. The git commit goes in `ConnServerCommit`. The bundle is
not notarized, so `spctl` rejects it ("Unnotarized Developer ID"); that does not matter for a
launchd job, because Gatekeeper checks only quarantined files.

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
| `t3 auth pairing create                                                                                                               | list                                                                                                                                     | revoke`, `t3 auth session issue | list    | revoke`                                                                           | Done with the same flags and output (`--json`, `--token-only`, `--base-url`, a repeated `--scope`; also `--scopes <list>`) |
| `t3 thread list [--project] [--json]`, `t3 thread start <project> <message or -> [--title --provider --model --worktree --branch --wait --json]`, `t3 thread send <thread> <message or -> [--wait --json]`, `t3 thread show <thread> [--messages --json]` | Done (section 1, "Task turns"); output, error texts and exit codes as the T3 CLI |
| `t3 project add <path> [--title]`                                                                                                     | Done (see section 1); `remove` and `rename` not built                                                                                    |
| `t3 environment link-orbit <gateway-environment-id> [--access --gateway-url]` | Done (`src/orbit_link.rs`): pairs through the Orbit Gateway with the system curl, as T3; same output, codes and messages (`tools/orbit-link-diff.mjs`). `link`, `list` and `unlink` not built: the server serves peer links (`peerLinks.*`, the link tools on `/mcp`). Orbit does not call them |
| `up`, `status`, `connect`, `service`, `update`, `install`, `doctor`, `policy`, `theme`, `trace`, `triage`, `browser`, `app` | Not built; none is used by Orbit or the desktop                                                                                          |

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
| `statev2.sqlite` (+ `-wal`/`-shm`), `state.sqlite`                                                                                                                 | Threads, projects, auth sessions and pairing links (`auth_sessions`, `auth_pairing_links`), everything else | **Read once, never written.** At the first start (no `engine.sqlite` yet) its projects and threads become `engine.sqlite` (`conn-engine/src/t3_import.rs`, below), and its live bearer sessions, unspent pairing codes, peer links and scheduled tasks go to `auth.json`, `peer-links.json` and `scheduled-tasks.json` (`src/t3_carry.rs`): paired devices and Orbit keep their tokens |
| `secrets/` (`server-signing-key.bin`, …)                                                                                                                           | Secret store, signing keys                                                                                  | Reads T3's `server-signing-key` to accept the session tokens T3 issued (carried-over sessions only) and the `peer-link-*` tokens of peer links; writes `peer-link-*` and the MCP OAuth key in the same format |
| `model-manifest.json` | The model catalog fetched from T3 Code's GitHub (`ModelManifest.ts`), `{"fetchedAtMs","manifest"}` | **Writes it the same way**: when (start, then at most hourly, 5 minutes after a failed try, only with `enableProviderUpdateChecks`), what (a manifest that decodes and is not older than the bundled or cached one) and the bytes (`model-manifest-diff.mjs`). Reads no model from it. Test seam: `CONN_MODEL_MANIFEST_URL` (`off` never fetches; an `http(s)` URL fetches from there); every check sets `off` |
| `attachments/`, `logs/`, `anonymous-id`, `themes/`, `browser-artifacts/`, `annotations/`, `speech/`, `providers/`, `usage-model-rates.json` | Feature data and caches                                                                                     | Ignored (other tracks may take attachments and logs)                                                                                                                                    |
| `<home>/worktrees`, `caches`, `runtime`, `tools`, `projects`, `scratch`                                                                                            | Worktrees, caches, managed tools                                                                            | Ignored                                                                                                                                                                                 |
| `engine.sqlite`, `auth.json`, `auth.lock`, `projects.json`                                                                                                         | —                                                                                                           | **Conn Server only**: event store, sessions and links, projects added with `project add`                                                                                                |

Switching back to the T3 server: settings, keybindings and the environment id carry over;
threads, sessions, pairings, peer links and scheduled-task changes made on the Conn Server do
not. A session revoked on the Conn Server is live again under the T3 server.

**Thread-history import (built, 2026-11-21).** `serve` imports it itself, before it listens,
when the state folder holds `statev2.sqlite` and no `engine.sqlite`: T3's file is attached
read-only, every projection row is copied with its id and its JSON body in one transaction,
the shell rows are computed, and the new store is renamed into place when it is complete. T3's
file is not changed, so the T3 server can take over again with every thread it had. Live state
is not resumed by the import: the engine's restart recovery ends runs that were live, as after
any restart, and the provider resumes by its own session id on the next turn. Proof and limits:
`docs/status.md`, "T3 state import".

## 6. Making the Conn Server the default

The T3 server (`apps/server`) stays as upstream has it. The Conn Server becomes the default
place by place; each place keeps a way back.

**(a) Orbit containers.** Ready when: `/mcp` serves Swamp's tools; `project add` reaches the
running server; `forceStopThread` and the thread methods Swamp uses work; the Codex provider
works through the AI router; a container has run a week of real use with the client showing
no "not supported" error on the paths users take; memory is measured in the container.
**Selection:** the agent bundle's `bin/t3` points at `conn-server` instead of the T3 tarball
(the recipe's `instances.agent.t3` entry). Orbit needs no other change; rolling back is the
recipe entry again. Moving an existing container keeps its settings, identity, threads,
sessions, peer links and scheduled tasks (section 5).

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
  version whose contract it speaks, and the digest of the contract it was generated from
  (`conn-server 0.1.0 (T3 server 0.1.9 contract, contract digest 3f2a9c…)`). Release notes
  name the same three.
- **The contract digest.** `crates/conn-contract/methods.json` records `contractDigest`, the
  sha256 of the tracked contract inputs (`packages/contracts` and T3's `ProviderAdapter.ts`)
  by path. It depends only on the tree: a commit id could not name the commit that changes
  the contract, and a shallow checkout has no history. `gen-contract.mjs --check` fails when
  Conn's contract moved. A Conn release that changes the
  contract needs a Conn Server release built from it before Orbit or the desktop takes both.
- **Which server a client talks to.** The descriptor (`/.well-known/t3/environment`) stays
  T3's: `serverVersion` is the T3 version whose contract is served, so clients' version checks
  behave. `GET /health` answers only on the Conn Server, with
  `{"server":"conn-server","version","contractDigest","methods"}`; the T3 server has no such
  route. A typed field (for example `serverImplementation` in the descriptor) would need a
  contract change in Conn first.
- **Tools that need Conn.** `tools/gen-keybindings.mjs`, `fixtures/recorder` and the other
  Node tools read the monorepo two levels above `apps/conn-server` (`tools/monorepo.mjs`).
