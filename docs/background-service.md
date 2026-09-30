# Background service

## Install or update the CLI from this fork

### Packaged releases (no repository checkout)

Fork releases produced by this workflow include `install-t3-cli.mjs`, `t3code-cli.tgz`, and
`t3code-cli.sha256`. Download the installer from the desired
[fork release](https://github.com/ronak-guliani/t3code/releases), then run it with that exact version:

```sh
node install-t3-cli.mjs 0.0.XX
```

Replace `0.0.XX` with the downloaded release's version; older releases do not have these assets.
Install Node **24.13.1 or newer within Node 24** and Git first. The installer checks Node,
architecture, npm, Git, and destination writability before fetching the archive. It downloads
only from this fork, checks the release's SHA-256, installs production dependencies into an
immutable version directory, verifies executable identity, and atomically selects the result.
The checksum detects corruption; it is not an independent signature of a compromised release.
Package dependencies may run their normal native installation scripts.

The command is `~/.t3-cli/bin/t3-rg` on macOS/Linux or
`%USERPROFILE%\.t3-cli\bin\t3-rg.cmd` on Windows. Add that directory to your **user** PATH, or use
the full path printed by the installer. It does not overwrite another `t3` command, change your
desktop installation, or update a running service implicitly. Old CLI snapshots remain available
for rollback; reinstalling a prior released version selects it without touching server data.
Concurrent installs are refused; a crash can leave `~/.t3-cli/install.lock`. Inspect its owner
record and confirm that installer exited before removing that specific lock directory.

```sh
t3-rg installation identity --json
t3-rg installation preflight --role host --base-dir /path/to/existing/home
t3-rg connect --role host --base-dir /path/to/existing/home
t3-rg service update --base-dir /path/to/existing/home
```

Identity reports distribution, version, release channel, commit, Node executable, and CLI
entrypoint. `service update` preserves saved cwd, host, and port; optional flags explicitly
override them. Legacy services without saved invocation metadata require one explicit
`service install` with their original flags before updates can preserve those settings.
Service snapshots include dependencies but use the installed Node executable; keep that Node
installation available and rerun `service install` after moving it.

### Source installation

Pulling source changes does not rebuild an existing `t3` executable. If another Mac still prints
`Start T3 to provision this environment.` after accepting background setup, update its CLI rather
than repeatedly running the old installer. From an up-to-date checkout with dependencies installed:

```sh
pnpm install:t3:cli --connect
```

This builds the web assets and CLI with the public Connect configuration, installs a self-contained
runtime under `~/.local/share/t3`, updates the existing user-owned `t3` symlink on PATH, and runs
Connect setup using that exact new binary. It waits for relay readiness and fails explicitly
if setup does not come online instead of treating account authorization as a working connection.
It does not modify the desktop app, delete old CLI
installations, or migrate account data. With no existing CLI, a user-owned bin directory must be
on PATH. Regular executable files and system-owned installations are not overwritten.

Use `--base-dir /path/to/existing/home` when the host uses a custom data directory. Stop a
foreground T3 server using that directory before setup. Complete browser sign-in and the
background-service prompt when shown. Without `--connect`, the command only updates the CLI.
Re-run it after pulling future CLI fixes; merging or updating source alone does not update
installed binaries.

### Agent CLI reliability

New provider processes inherit a private `t3` launcher for the running server's CLI build
and `T3CODE_HOME`, rather than an unrelated installation on PATH. Restart an existing provider
session after updating the server. This does not replace the user's installed `t3`. Packaged
`--version` includes the build commit when available; `installation identity --json` also
reports the executable and entrypoint. If snapshot decoding reports `CLI_SERVER_INCOMPATIBLE`,
update both components or use the server-matched launcher.

Management-command stdout is reserved for results; diagnostics and failures go to stderr.
Invalid-argument help also goes to stderr; requested help stays on stdout without an error.
Failures exit nonzero and include a JSON `error` with `code` and `message`. Stream commands
remain long-lived; individual unary WebSocket RPC replies have a 30-second deadline. A timeout
does not prove a mutation was rejected: inspect its outcome before retrying. Mutations are not
automatically replayed.

`chat show` now resolves an ID or unambiguous title without downloading the global shell.
History views return the newest 50 entries in chronological order, without checkpoints:

```sh
t3 chat show THREAD_ID
t3 chat show THREAD_ID --messages --limit 20
t3 chat show THREAD_ID --activities --limit 20
t3 chat show THREAD_ID --messages --before CURSOR_FROM_PAGE_BEFORE
t3 chat show THREAD_ID --full
```

Pages expose `page.hasMore` and `page.before`; cursors are bound to the thread and history
view. The maximum page size is 200. `--full` preserves the previous detail shape, including
checkpoints, recent activities, and pending-request context. It is also the explicit legacy
read for older servers without the targeted-read API. Archived threads remain readable.
The three history view flags are mutually exclusive, and pagination is unavailable with `--full`.
The targeted HTTP API returns 400 for invalid requests, ambiguous/missing threads, and invalid
cursors; internal repository failures remain 500.
Use `--full` instead of `--messages` in scripts that require the previous combined detail
shape. Pending approval and question listings include requests outside the recent activity window.

`t3 service install` installs the exact packaged CLI and its installed production dependencies as a per-user service and starts it immediately. The private snapshot includes native assets, does not depend on the original checkout's `node_modules`, and is checked before replacing a working service. Re-running install repairs the definition and replaces the runtime, so run it again from the newly installed packaged CLI after an upgrade.

For T3 Connect, start with `t3 connect --role host`: sign in and accept the background-service prompt. You do
not need to start `t3 serve` first or configure a domain, VPN, or a second connector. Once
`t3 connect status` says **linked and online**, sign into the same account on each client and
select the host in its T3 Connect environments.

### Use all your hosts from the desktop app

In the fork desktop app, open **Settings > Connections > Your T3 Connect devices** and
choose **Sign in**. Complete sign-in in the browser. The app discovers your account's
linked machines automatically and refreshes discovery while it is running; manual
pairing links are not required.

- **Add Project** lets you select a machine and browse that machine's folders.
- The composer's **Run on** selector lists connected machines. If the current logical
  project does not exist on the selected machine, choose its target folder explicitly.
  Your draft is retained; the previous machine's worktree path is not reused.
- Commands, terminals, files, and Device panels use the selected environment.
- **Sign out** disconnects account environments in this desktop app. It does not unlink
  hosts, stop their services, or sign the host CLI out.

Desktop account credentials live separately under the app's user-data directory.
Refresh credentials and private DPoP keys stay in the native process. Discovered account
environments are ephemeral and are never saved as manually paired environments. HTTP
requests and renewable WebSocket connections use the native account broker. Standalone
web clients retain their existing manual-pairing flow.

If a foreground server already uses the intended base directory, stop it before installing.
The installer reports its PID rather than silently running two servers against the same data.
Keep `--base-dir` consistent across `connect`, `service`, and `serve` commands; account
authorization and paired-device data remain there. New services bind to loopback by default.

```sh
t3 service install --base-dir ~/.t3 --cwd ~/code --host 127.0.0.1 --port 13773
t3 service status
t3 service disable
t3 service enable
t3 service restart
t3 service stop
t3 service start
t3 service uninstall
```

On macOS this creates a per-base-directory LaunchAgent. It starts when that user's GUI session logs in, survives terminal logout, restarts after crashes, and returns after reboot only after the user logs in. macOS may require approval in **System Settings > General > Login Items & Extensions**.

Windows uses a separate named Task Scheduler task per user and data directory. It runs as that
user with `InteractiveToken` and least privilege, without storing a Windows password. It starts
after sign-in, retains that user's provider credentials/workspace access, allows battery operation,
has no execution time limit, and retries crashes up to three times at one-minute intervals.
It does not keep a sleeping laptop reachable. Start/stop/enable/disable/status/update/uninstall
use the same CLI commands as macOS. Managed Windows state must be inside the user's profile;
untrusted ownership or writable-by-other-user ACLs are refused. A failed candidate restores the
previous task; if shutdown/rollback cannot be confirmed, snapshots remain for recovery.
Use `service status --json` to inspect the supervisor and observed runtime owner separately.

Linux service support is intentionally deferred until systemd user-manager and linger behavior
can be production-tested across supported distributions. Packaged CLI and foreground hosting
remain available there; guided managed-host setup is for macOS and Windows.

The instance-specific definition path and rotating server log are shown by `t3 service status`. The log is the normal bounded `userdata/logs/server.log`; launchd stdout and stderr are discarded instead of appending a second unbounded log. Each service instance writes health discovery state inside its private runtime directory, so a foreground server using the same base directory cannot satisfy or lose the service health record. Status reports launchd loaded state, process state/PID, and HTTP responsiveness rather than treating a definition file as proof of availability. Uninstall stops and disables that base-directory instance and removes only that instance's definition and runtime artifacts.

Startup waits for launchd to publish a running PID before checking that PID's HTTP endpoint.
Restart waits for the previous job to unload before bootstrapping its replacement; it does not
kill the process that `RunAtLoad` has just started. A failed candidate restores the previous
service when shutdown succeeds. If launchd cannot confirm shutdown, the installer reports that
failure and retains the runtime rather than deleting files a process might still be using.

### Guided setup and resumable failures

`connect` without a role asks whether to **host here** or **connect to another computer**.
`connect --role client` prints the hosted app/desktop connection instructions without creating
an environment, running migrations, authorizing a host, downloading a connector, or installing
a service. Client sign-in happens in the client app; `connect login` remains the explicit
CLI-account authorization command and does not enable exposure.

Host setup selects an existing local environment or shows the proposed new directory. Supplying
`--base-dir` pins the choice and skips this prompt. The stages are preflight, account authorization,
relay-client installation, server startup, and relay readiness. Failures identify the stage and
retain completed work. Retry **the same executable, role, and base directory**: stored credentials
and relay binaries are reused, and an already-current healthy host is not restarted unless
authorization/exposure changed or live state shows it still needs provisioning. Readiness polling
is bounded to 60 seconds and reuses one temporary CLI session, revoked afterward.

Preflight checks the supported Node/architecture, embedded Connect config, writable state path,
packaged web client, native terminal module, Git, package manager, provider executables, and proxy
environment presence. Proxy values are redacted. Missing optional provider binaries are warnings;
provider authentication and external network accessibility must still be confirmed separately.
Preflight does not start providers or authenticate accounts.

**Host ready is not client verified.** After relay readiness, setup explicitly leaves client
verification pending: sign in on the other device and open this environment. It never claims
that another device connected based solely on a local health probe.

### Manage account registrations from any client

Desktop and web expose **Settings > Connections > Manage / Deregister environments**, which
opens the hosted account page. Mobile has **Deregister** on T3 Connect environment rows.
The hosted account page needs Clerk and secure relay configuration, not a CLI OAuth client ID;
that ID is required for terminal and native desktop sign-in.
These actions use the account relay, so the host can be offline. CLI equivalents are:

```sh
t3 connect environments --base-dir /path/to/existing/home
t3 connect environments --json --base-dir /path/to/existing/home
t3 connect deregister --environment EXACT_ENVIRONMENT_ID --base-dir /path/to/existing/home
```

Confirm the stable environment ID, not only its display name. Deregistration defaults to
cancel; automation must pass `--yes`. It removes the account registration for all devices,
not projects, history, or drafts. It does **not** revoke already-issued sessions. Disable an
enabled host first so it cannot automatically register again.

| Action                                    | Effect                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| Switch off on this client                 | Pauses retries on this device; keeps credentials, cached history, drafts, and outbox. |
| Remove from this device                   | Forgets this device's connection; local removal may clear its drafts and outbox.      |
| `t3 connect disable --base-dir ...`       | Stops this host's Connect exposure while retaining account sign-in and registration.  |
| `t3 connect deregister --environment ...` | Removes the account registration, including an offline host.                          |
| `t3 connect unlink --base-dir ...`        | Disables this host and removes its account registration.                              |

The current relay lists stable IDs, labels, endpoints, and registration dates. It does not
expose actual tunnel quota usage/limits, last-seen time, installation type, or build. Clients
report that absence explicitly (`tunnelQuota: null` in CLI JSON). Registration count is not
tunnel usage, and registration age does not establish staleness. Cleanup is always explicit;
no registration is automatically deleted. Capacity failures retain the relay's actual limit
and trace ID when provided.

Account-bound credentials are isolated by account, relay, key, environment, and authorization
scope. Shared-runtime HTTP reads renew expiring DPoP tokens once per environment without
closing a healthy WebSocket; a rejected read retries once with a fresh proof. Permission
failures and mutations are not automatically replayed. CLI reconnects obtain a new single-use
ticket and verify endpoint identity before sending cached credentials. Legacy bearer
connections remain supported.

Incompatible initial configuration is a blocked compatibility error rather than a transport
retry loop. Pairing verifies the authenticated cookie and reinitializes the browser router
without requiring a manual reload. Transient authorization recovery does not remove saved
connections, drafts, pending sends, or active work.

Both Windows file-backed secret stores enforce a current-user-only protected directory ACL,
with inherited permissions on existing and future secret files. Unexpected owners, reparse
points, or ACL failures stop initialization explicitly. This is access control, not encryption
or protection from an administrator. macOS keychain and POSIX secret handling remain unchanged.

### Runtime ownership and deliberate handoff

Runtime discovery records `desktop`, `foreground`, or `background`; older files report `unknown`.
This is diagnostic metadata, not a replacement for the lifetime startup claim.
To move a managed environment to another owner:

```sh
t3-rg service handoff --to foreground --base-dir /path/to/home
t3-rg service handoff --to desktop --base-dir /path/to/home
```

Handoff stops and disables the managed instance, checks for any remaining live runtime, and prints
the exact next action. It does not kill unrelated processes or launch a replacement implicitly.
For the reverse direction, quit desktop or stop the foreground terminal first, then run
`connect --role host` or `service install` with the same base directory. Data and provider
credentials stay in place. Do not hand off while turns are active.

### Build contract

Root `pnpm build` explicitly builds `@t3tools/web` followed by `t3`; it cannot succeed by scheduling
zero workspace tasks. Web builds stamp source fingerprints plus a normalized hash of effective
public Vite/Connect configuration from process environment and root env files; no environment
values are stored in the stamp. Server packaging refuses missing or changed web inputs and
rechecks after bundling, rather than accepting a warning or stale client directory.
Run the root build after changing web/shared/contracts/client-runtime sources or public configuration. Standalone
`pnpm --filter t3 build` requires a matching web build.

### Multiple desktop and CLI environments

Threads belong to a server environment, not the phone, browser, or desktop viewing it.
Identical project names or folders on two environments do not imply shared history.

Use this fork's executable (not an unrelated `npx t3` installation) to inspect and choose:

```sh
t3 local list
t3 local select --base-dir /absolute/path/to/existing/.t3-rg
```

The explicit selection is stored in `~/.config/t3/local-environment.json` with the environment
ID. Ordinary CLI defaults and the regular desktop application follow it on their next launch.
`--base-dir`, `T3CODE_HOME`, injected agent targets, and development desktop launches retain
their explicit isolation. A missing or changed selected identity fails rather than opening
another environment. Existing legacy `~/.t3` defaults remain valid; when it is absent but a
known non-development home exists, the CLI asks you to select one instead of silently creating
another. Discovery checks known home directories, not your entire filesystem.
If the saved selection is broken, `t3 local list` still prints healthy candidates and warns on
stderr; the desktop inspector shows the same warning without disabling explicit selection.
Startup remains blocked until you repair the selection; discovery never changes the default.

On first regular desktop launch, choose an existing **stopped** environment or explicitly keep
a separate desktop environment. Desktop starts its bundled backend in the selected directory.
If another server is running there, desktop refuses to start: it neither mints a pairing
credential nor loads that server's pages into its privileged renderer.

**Automatic attachment is disabled for security.** Matching public environment IDs, live PIDs,
and file ownership do not authenticate the HTTP listener. Safe automatic attachment requires
an authenticated transport that remains bound to the intended server instance.

To keep a CLI/service environment running, launch desktop with a separate `T3CODE_HOME`, then
add the running environment through **Settings > Connections** using explicit pairing or
Connect. The existing host is an API connection, not the source of the privileged desktop
application. Alternatively, stop the CLI/service first and let desktop own that environment.
Selection never stops another process or silently falls back to a different directory.

Every server launcher acquires a lifetime startup claim before services, migrations, or HTTP
startup, then rechecks persisted runtime ownership. The claim uses a dedicated
`server-startup.sqlite` file in the selected state directory; never delete it to bypass a
running server. A losing launcher exits without starting another backend, and process exit
releases the claim. Keep environment state on a local filesystem with working SQLite locks.

**Settings > Connections > Local environments** shows identity, data directory, process,
endpoint, build, and whether desktop owns the backend. Selection requires native confirmation
and restarts desktop; finish active desktop work first. Dev builds and explicit home overrides
show their pinned state and cannot silently change their own target through this picker.

Thread headers, sidebar rows, search results, and the composer identify their execution host.
The **Other environments** hint offers loaded threads from same-named projects on other hosts;
it is a possible-mismatch hint, not proof that two repositories are identical. Connect or add
an environment before expecting its threads to be visible.

#### Safe consolidation and recovery

Choose one environment as the default and retain the others as explicit connections for their
history. Selection never merges databases, moves project checkouts, deletes old environments,
or replays provider sessions. Before retiring an unused environment, stop it and make a backup:

```sh
t3 local backup --base-dir /absolute/path/to/home --output /private/backups/t3-before-consolidation
```

The output must be a new directory outside the source. A completed backup has a versioned
manifest with per-file SHA-256 hashes. Running/unverifiable environments, changed source files,
symlinks, special files, and existing backup destinations are refused. An incomplete backup is
retained for diagnosis without a usable manifest; the original is never modified.

Backups include private history **and credentials**. Store them privately, restrict Windows
folder permissions to your user, and never upload or commit them. This is a full data-directory
backup, not a portable history interchange format; external project checkouts and OS keychain
entries are not included.

Recovery is intentionally limited to the original, absent directory. Stop all writers,
preserve the old directory separately, then run:

```sh
t3 local restore --archive /private/backups/t3-before-consolidation --base-dir /original/absolute/path/to/home --confirm
```

Recovery verifies the manifest and identity, stages files before publishing, and discards stale
runtime PID information. It refuses existing destinations, portable identity clones, and merges.
Keep preserved copies stopped. Do not run two copies of the same environment identity.
Moving individual threads between existing environments is not supported by this workflow;
keep both connected or use the existing Markdown thread export for a reference copy.

Each environment must keep its own data directory. Do not start a foreground `t3` against a
directory already served in the background. Connect targets the server's actual listening
address family and port rather than `localhost`, so a separate IPv6 server cannot intercept
a desktop environment's IPv4 tunnel. Desktop and CLI builds both need this startup fix;
updating only the CLI does not update an already running desktop application's tunnel.

Connect link proofs require a loopback origin. Explicit interface binds such as
`--host 192.168.1.20` are not supported for Connect; startup reports this limitation.
Use `--host 127.0.0.1` or `--host ::1` for local-only access, or a wildcard bind
(`--host 0.0.0.0` or `--host ::`) when LAN access is also required. Wildcard binds
expose the listener to other interfaces; Connect still targets matching-family loopback.

If mobile reports `endpoint_request_failed`, a running connector alone does not prove that the
endpoint is healthy. Compare `/.well-known/t3/environment` on the host and its public endpoint:
the `environmentId` must match. Do not delete mobile environments to repair host routing;
removal clears local drafts and queued work.

## Owned Remote Access (no phone VPN)

Use a permanent Cloudflare Tunnel to connect phones, tablets, and browsers over ordinary
Wi-Fi or cellular. Each T3 environment has its own hostname, tunnel, and persisted identity.
Multiple clients can pair with one environment; each client can also save multiple environments.
No T3 Connect account, Clerk configuration, or phone-side connector is needed.

### One-time setup on each host

1. Use this fork's packaged CLI with a fixed port and background service. Keep the existing
   fork's base directory if you want its current environment identity and sessions. Never run
   two servers against that directory. The example below uses a separate fork-owned directory,
   not the official app's `~/.t3`:

   ```sh
   t3 service install --base-dir ~/.t3-rg --host 127.0.0.1 --port 13773
   ```

2. In your own Cloudflare account, create a **named, remotely managed tunnel** and a public
   hostname such as `mac.example.com` on a domain you control. Point its HTTP service to
   `http://127.0.0.1:13773` (use the actual fixed T3 port). Leave the HTTP Host header override
   unset so the public host is preserved. Do not use a temporary `trycloudflare.com` URL.
   Do not also run the dashboard's connector installation command: T3 owns this connector.

3. Require HTTPS for that hostname, enable WebSockets, and configure a cache bypass for the
   entire T3 hostname. Do not place an interactive Cloudflare Access login in front of the API:
   native clients use T3's pairing/session authentication, not a Cloudflare browser login.
   Cloudflare is a trusted transport intermediary; this is not end-to-end encryption that
   hides application content from Cloudflare.

4. Run the guided setup on the host:

   ```sh
   t3 remote setup --base-dir ~/.t3-rg
   t3 remote status --base-dir ~/.t3-rg
   ```

   Enter the HTTPS origin and **only the tunnel token** at the hidden prompt, not an install
   command. No Cloudflare account-wide API key is required. Credentials stay in the host's
   restricted secret store, not shell arguments, client configuration, or status output.
   T3 installs its pinned connector if needed and restores it on subsequent server starts.
   Status refreshes approximately every ten seconds; readiness requires an HTTPS probe to
   resolve to this exact environment, not merely a running connector process.

5. Once ready, create a fresh one-time pairing link for each client:

   ```sh
   t3 pair --remote --base-dir ~/.t3-rg
   ```

   Alternatively, use **Settings > Connections > Remote Access > Pair remote device** in
   an owner session. Scan in the mobile app or open the link in a browser. Keep pairing
   links private. Each client receives its own revocable session; do not share one link
   between devices. Repeat host setup and client pairing for a second computer.

For an existing LAN/Tailscale registration, pair again through the new HTTPS address.
The shared connection catalog identifies the environment by ID, not its hostname.
Do not delete the environment first: deletion intentionally clears its local drafts/outbox.
Do not copy credentials to a different host or change environment IDs to make them match.

### Recovery and control

```sh
t3 remote disable --base-dir ~/.t3-rg
t3 remote enable --base-dir ~/.t3-rg
t3 remote status --base-dir ~/.t3-rg
t3 service status --base-dir ~/.t3-rg
```

Disable persists before stopping the connector, so restarting T3 cannot silently re-enable it.
It leaves the Cloudflare tunnel/DNS and paired sessions intact. Revoke individual clients from
**Authorized clients** in Connections or the existing `t3 auth session` commands.
To rotate a tunnel token or change hostname, rerun setup. Never reuse one tunnel for different
independent T3 environments: Cloudflare can distribute requests across its connectors.

The connector handles temporary network loss; T3 bounds process-crash retries and periodically
rechecks endpoint health. Client reconnection continues to use existing resnapshot, draft, and
outbox behavior. A hostname mismatch blocks new pairing. If credentials cannot be read, T3
stops its connector instead of continuing with unknown configuration.

Your host must remain awake and online. The macOS service starts after user login, not before
login following a reboot. Linux/Windows automatic service installation is not supported yet.
Use a packaged server for persistent/public access, not a Vite development server.
Remote Access does not enable OTA updates, push notifications, or automatic account discovery.

### Release acceptance

Before relying on a deployment, check two independently paired clients and two independent
hosts; cellular/Wi-Fi changes; sleep/wake; server/connector restart; interrupted streams and
queued sends; and revocation of one client while another remains connected. Test attachment
uploads against the configured Cloudflare plan's request limits. Check that unauthenticated
HTTP/RPC and WebSocket requests are rejected and that no credentials appear in caches or logs.
Automated local coverage is not evidence of a real Cloudflare or physical-phone connection.

### Deferred

- TODO: account sign-in and automatic environment discovery, reusing upstream Connect contracts.
- TODO: managed account-level provisioning if manual tunnel setup becomes a recurring burden.

## T3 Connect and direct Tailscale HTTPS

Connect onboarding offers background installation after linking. A service failure does not undo the successful link. The service itself does not require Clerk or a relay.

For direct Tailnet access, bind T3 to a fixed loopback port, then let `t3 pair` provision and validate the persistent HTTPS mapping:

```sh
t3 service install --host 127.0.0.1 --port 13773
t3 pair --base-dir ~/.t3 --tailscale --label "Mobile device"
tailscale serve status
```

Scan the printed QR code in the RN app or open the same canonical URL in a browser. Tailscale Serve persists independently across T3 restarts. Use the exact per-port removal command printed by `t3 pair`; avoid `tailscale serve reset`, which removes unrelated mappings too.

The service definition contains its startup paths and selected non-secret configuration. Pairing/session credentials still grant workstation access: use Tailnet ACLs, revoke unused T3 sessions, protect the workstation account, and do not expose the port directly to an untrusted network.

### Automatic endpoint discovery

Authenticated clients can read `GET /api/remote-access/endpoints` with an
environment session carrying `relay:read`. The response is the additive
`AdvertisedEndpoint[]` contract: it may include the live listener's loopback,
LAN, private-network, and public candidates, plus a Tailscale IP or an already
configured Tailscale Serve HTTPS mapping. A missing route on an older server is
treated as no discovery candidates.

Discovery uses the listener address family and actual bound port, including
ephemeral ports. Wildcard listeners are projected only onto usable interfaces
in the same family; loopback, link-local, and multicast addresses are not
invented as LAN candidates, while private Docker/VM bridge addresses remain
eligible. Existing Tailscale Serve mappings are inspected read-only and are
advertised only when their loopback proxy target and HTTPS environment identity
match this server. Discovery never enables Serve, changes firewall exposure, or
turns plain LAN HTTP into an implicitly trusted transport. `401` means there is
no authenticated environment session and `403` means the session lacks
`relay:read`.

## Pausing a saved connection

In Settings -> Connections, switch a saved environment off to pause it **on this
client only**. The choice survives restarts, stops connection retries, and hides
that environment's projects and threads from combined workspace lists. Credentials,
cached history, and drafts are retained; switch it back on to reconnect without
pairing again. On mobile, saved direct connections and T3 Connect rows use the
same switch. Long-press a saved T3 Connect row to remove it instead.

Pausing does not stop the host service or server-side agent work, disable remote
access, or affect other clients. **Remove from this device** forgets the saved
connection and requires pairing again. **Deregister from account** is a separate
account-wide action.
