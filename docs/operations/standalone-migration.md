# Running a fork without T3-operated services

This runbook is for running a fork whose environment server, web app, desktop app, and mobile app
are operated by their owner, whether starting fresh or moving an existing installation. It
separates what works with direct pairing today from work still needed for a strict no-T3-network
build. It is not a deployment recipe for the T3 Connect relay.

## Choose the boundary

The **environment** is the server on the machine that owns the projects, provider credentials,
files, and database. Clients connect to it over HTTP and WebSocket. The environment can run on a
laptop, desktop, or VPS. Moving only the web UI to a VPS does not move projects from a laptop to
that VPS. See [remote architecture](../internals/remote.md).
On a different machine, the saved absolute project paths and provider credentials must also be
made available there; copying the database alone does not move them. A copied home retains the
environment identity, so never run both copies online at the same time.
For projects on several machines, run one environment on each machine. A forked web, desktop, or
mobile client can save several directly paired environments; a central VPS is not required for
project discovery across those environments. Without a relay, each client must receive a
reachable route and pair with each environment separately.

For an installation whose projects live in infrastructure you operate, place the environment on
the host that contains those project directories. Keep its T3 home and provider CLI credentials on
storage owned by that installation. A single host is enough to start; add another environment
only when projects or credentials need to live on another host. A web server that serves only the
client bundle does not run agent turns or provide access to project files.

Direct pairing over LAN, a private VPN such as Tailscale, or SSH does not require T3 Connect. A
public browser origin needs a reachable HTTPS address for the environment; hosting the web app
alone does not provide one. See [remote access](../user/remote-access.md#pair-over-a-lan-or-private-network).

There are two distinct milestones:

1. **Independent core:** run the fork's environment and use direct routes. Do not sign in to or
   link T3 Connect. Projects and agent turns then have no T3 relay in their request path.
2. **Strictly independent clients:** build and distribute the web, desktop, CLI, and mobile clients
   with no T3-operated endpoint for telemetry, links, updates, or diagnostics. Official clients do
   not meet this milestone merely because they connect to a forked environment.

Provider subscriptions and their CLIs remain external services chosen by the operator. This
runbook addresses T3-operated services, not those provider services.

## Target deployment on owned infrastructure

Provision the environment host and its persistent project and T3 home storage first. Run the
forked server as a dedicated operating-system user with access to those directories and the
chosen provider CLIs. Keep the environment's HTTP and WebSocket endpoint on a private network,
or put an HTTPS gateway you operate in front of it. The gateway must forward WebSocket upgrades
as well as ordinary HTTP requests. Host the forked web bundle at an HTTPS origin you control;
the browser must be able to reach the environment endpoint from that origin. Pair each forked
desktop and mobile installation directly with the same environment.

Back up the T3 home and project directories together, protect provider credentials, and rehearse
restoring them to an offline host before relying on the new service. Monitor process health,
storage, failed backups, and the externally reachable route. Keep the server and clients pinned
to tested fork revisions during cutover. If the project is new and has no official T3 state to
preserve, start with an empty T3 home; the data-copy steps below apply only to existing state.

## Inventory before migration

Record the exact version and release channel of the installed CLI, desktop app, and each mobile
app, plus the fork commit used for the replacement. On the host, `t3 --version`, `t3 status`, and
`t3 service status` identify the CLI and background service. Read the desktop and mobile versions
from their About screens. Check whether desktop and the background service share a T3 home,
whether T3 Connect is linked, which devices use it, and which projects and provider credentials
must survive. Record the routes each client uses; a T3 Connect route must be replaced with a
direct route before cutover.

Do not run the official server and the fork against the same T3 home. In particular, never start
a development server against a live `~/.t3/userdata`. The database can migrate forward when a
newer server starts, so a version rollback must use a backup made before that start.
If the destination already runs T3 Code, keep its database intact: there is no supported way to
merge threads from two environments. Start the copied installation with another T3 home and port.

## Prepare an isolated replacement

1. Pin a fork commit or published release. For a source build, use the Node version required by
   the root `package.json`, follow [development setup](./development.md#first-checkout), and keep
   its commit SHA. A source build can run the server with `node apps/server/dist/bin.mjs`; it does
   not use the installed launcher or its update path. Use a published fork release for the service
   that will receive automatic updates.
2. Give the replacement its own T3 home. If there is official state to preserve, make a copy of
   that data. A staging copy made while the official server is running must use a consistent
   SQLite snapshot; the dev database migration tool intentionally drops tasks and links, so it is
   a test fixture, not a complete migration. For the final copy of existing state, stop the
   official desktop and service, confirm no server still owns the database, then copy the entire
   userdata directory, secrets, settings, and any needed `service.env` into the new home. Review
   copied configuration for T3 Connect and update endpoints before the fork starts. Keep the
   original home and an offline backup unchanged.
   Moving from another OS also means moving each project's files and Git metadata. Project and
   thread worktree paths are absolute; a fresh clone omits the `refs/t3/**` checkpoint refs that
   old thread diffs and restores use. Keep the original paths where possible, and verify old
   threads before accepting the copy. Provider CLI sessions and OS credential stores may need a
   fresh login on the destination. A copied environment retains its identity, so do not leave
   both copies online together.
3. Run the forked environment with product telemetry disabled:

   ```dotenv
   T3CODE_TELEMETRY_ENABLED=false
   T3CODE_OTEL_SDK_DISABLED=true
   T3CODE_MODEL_MANIFEST_URL=off
   ```

   Set these in the process environment or the fork's `service.env` before it starts. The server
   otherwise defaults product telemetry to `https://ingest.t3.codes`; see
   [telemetry](../user/telemetry.md) and [service environment](../user/background-service.md#configure-the-service-environment).
   `off` uses the bundled model catalog without a background fetch. An HTTPS URL can instead
   point to a catalog you operate. Keep these explicit settings for source-run servers; a
   `T3CODE_STANDALONE=1` server build supplies safe defaults even when bundled in the desktop app.

   For a foreground staging server, use an absolute path to a copied, isolated home:

   ```sh
   T3CODE_HOME=/absolute/path/to/staging-home \
     T3CODE_TELEMETRY_ENABLED=false \
     T3CODE_OTEL_SDK_DISABLED=true \
     T3CODE_MODEL_MANIFEST_URL=off \
     node apps/server/dist/bin.mjs serve --lan
   ```

4. Give the environment a private or HTTPS route that the receiving device can reach. Pair each
   client directly with a new one-time code; do not reuse T3 Connect sessions. Test project
   listing, a provider turn, reconnect after restart, and the permissions of each paired client.
   Keep the first test on isolated data, then repeat after the final offline copy.

## Publish and update a forked Linux service

Configure the fork's `T3CODE_APP_SCHEME`, `T3CODE_APP_NAME` and `T3CODE_MOBILE_BUNDLE_ID` build values before tagging; use the
same values for the server and client builds. After reviewing and merging a tested commit, push a `vX.Y.Z` tag on that
commit. The fork's `fork-release.yml` builds Linux x64 and arm64 CLI archives, smoke-tests them,
and attaches them with `SHA256SUMS` to a **draft** GitHub Release, together with the desktop Linux
AppImages and their `latest-linux*.yml` update feeds. macOS DMG and zip builds and the merged
`latest-mac.yml` join once the Apple signing secrets are set; until then the workflow skips them,
because macOS refuses unsigned updates. Verify the workflow, archive names, checksums, and tested
commit before publishing the draft. Drafts are invisible to installed
clients; publishing makes the version available. Do not use the official npm package for this
service.

```sh
git tag vX.Y.Z <tested-commit>
git push origin vX.Y.Z
```

Install the published archive under a dedicated OS user with its own T3 home. The fork's
`scripts/install.sh` accepts `T3CODE_RELEASE_REPOSITORY=owner/repo` and an exact
`T3CODE_VERSION`; set both when installing. Run `t3 --version`, then `t3 service install` as that
user and confirm `t3 service status` reports the expected version and route. Keep an existing T3
installation under its original user and home during validation.

```sh
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/install.sh \
  | T3CODE_RELEASE_REPOSITORY=<owner>/<repo> T3CODE_VERSION=X.Y.Z sh
t3 --version
t3 service install
t3 service status
```

A standalone build's background service updates itself by default. Until the first fork release
and backup have been verified, put `T3CODE_AUTO_UPDATE=0` in the new service's `service.env` and
restart it; remove the line, or set it to `1`, to turn updates back on. The service checks published
releases on its selected stable or nightly channel after five minutes and then hourly. It waits while agents are running, verifies
the archive checksum and database preflight, and tests the new service before keeping it. A failed
start restores the previous version and database backup; the same failed version is not retried
automatically. Check the service log and `t3 service status` after publishing the next release.
To pause automatic updates, set `T3CODE_AUTO_UPDATE=0` and restart the service. A foreground
`serve` process does not use this scheduler.
The automatic rollback covers startup failure, not a defect discovered after a healthy start.
An update also closes open terminals; finish terminal work before publishing a release that the
service will install.

## Replace the client distributions

The repository's `.env.example` contains the production T3 relay URL. Do not copy it into a fork
build. Set `T3CODE_STANDALONE=1` for each client build and set
`GITHUB_REPOSITORY` or `T3CODE_DESKTOP_UPDATE_REPOSITORY` to your `owner/repo`. The build rejects
T3-operated relay, diagnostics, hosted-app, and mobile legal-site URLs, T3's Expo project ID, and
an upstream release repository. Use the same switch for server builds. A build made without the
switch retains the official defaults. Set `T3CODE_APP_SCHEME` to a lower-case scheme owned by the
fork; a standalone build rejects the official `t3code` scheme. Changing it gives the desktop a new
browser-storage origin, so keep drafts and saved connections in mind before replacing an older build.
Set `T3CODE_APP_NAME` to the fork's product name. The build renames "T3 Code" and the brand's other
"T3 ..." phrases in the bundles, every locale's catalog, and the desktop and mobile packaging; T3
Connect, T3 Chat, and the license text keep their names.

- **Web:** host the fork's static app at an HTTPS origin you control. Set
  `T3CODE_HOSTED_APP_URL` (also read as `VITE_HOSTED_APP_URL`) in the build and server only when
  you host it. With no hosted app, clients use direct pairing and native thread links. The URL
  may also be the fork's own server: a standalone page on it runs as a server-served client unless
  the build sets `VITE_HOSTED_APP_CHANNEL`, which marks a static hosted deploy. Leave
  relay, Clerk, and browser tracing values unset for direct-only use.
- **Desktop:** build and sign the fork's app under an identity you control. The app takes its
  bundle id from `T3CODE_MOBILE_BUNDLE_ID`, shared with mobile, and names its files after
  `T3CODE_APP_NAME`; sign it with a Developer ID profile for that id. Set the fork release
  repository at build time; the app then follows that repository's published GitHub releases.
  `T3CODE_DISABLE_AUTO_UPDATE=true` turns the desktop updater off until your feed is ready, or
  point the managed `updates.feedUrl` at your feed. It does not affect the background service. The bundled
  server inherits the standalone build's safe telemetry and model-catalog defaults. Verify them
  in the packaged app, not only in a source-run server.
- **CLI and SSH hosts:** distribute the fork's server/CLI archive with its checksums.
  A standalone server build points `t3 update`, self-update, SSH provisioning, and triage at the
  configured fork. Its install scripts accept `T3CODE_RELEASE_REPOSITORY=owner/repo`. Do not use
  these update and installation paths until fork archives and checksums are published and tested;
  `npx t3` still launches the official npm package.
- **Mobile:** build and distribute forked iOS/Android apps with your signing and identifiers.
  Set `T3CODE_MOBILE_BUNDLE_ID` to your app identifier and `T3CODE_IOS_TEAM_ID` to your Apple
  team when signing for iOS. The release check uses your configured fork repository.
  Set `T3CODE_EAS_PROJECT_ID` and `T3CODE_EAS_OWNER` only for an Expo project you operate;
  without them, standalone builds disable OTA updates. Set `EXPO_PUBLIC_MARKETING_SITE_URL`
  only for your legal site. Leave `T3CODE_RELAY_URL`, Clerk, and OTLP tracing values unset for
  direct-only use. Re-pair the new app to each environment and verify which local client state
  transfers before removing the official app.

  For a first iPhone pilot, the existing EAS `preview` profile can build on EAS Cloud after the
  device is registered with `eas device:create`. Start the build from Linux, set the fork's Expo
  owner/project, bundle ID, Apple team and app scheme, and leave OTA updates disabled. Install the
  resulting ad hoc build on the registered device, join the same private network as the server,
  and pair directly. Test again over cellular data. TestFlight distribution needs the fork's own
  App Store Connect app ID in the submit configuration; the existing ID belongs to T3.
  The server's automatic updater does not update the iPhone app. JavaScript-only mobile updates
  can use the fork's Expo project after OTA is enabled; native changes need a new signed build.

The [release runbook](./release.md) describes the upstream signing, archive, and update-feed
formats. Reusing its workflow in a fork requires replacing upstream credentials, domains,
distribution destinations, and release ownership; a fork checkout alone does not change them.

## Remaining network dependencies to close in the fork

These paths need configuration, implementation, or an egress test before declaring independence:

- **Model manifest:** use `T3CODE_MODEL_MANIFEST_URL=off` or point it at an HTTPS catalog you
  operate. With `off`, the bundled catalog and any newer disk cache remain available, but new
  compatibility information is not fetched.
- **Updates and installers:** publish and verify fork-owned release archives, checksums, and
  desktop feeds before enabling updates. The `t3` npm launcher belongs to the official package;
  standalone builds use the fork repository for release links and mobile maintenance checks.
- **Links and fallbacks:** a standalone client build removes the ordinary hosted-app,
  download/legal, issue, prompt/thread, and crash-recovery links to T3. With a local project
  configuration, run `t3 project schema > t3.schema.json` beside `t3.json` and set its `$schema` to
  `./t3.schema.json` so the editor does not fetch the official schema URL. Do not configure T3
  Connect in a direct-only build; verify any configured hosted-app, OAuth return and help links.
- **Telemetry and diagnostics:** verify that the server, desktop, web, and mobile builds have no
  T3 ingest, relay tracing, or mobile Observe endpoint. Server opt-out alone does not control
  separate browser or mobile clients. If sending product analytics to your own PostHog host,
  configure both `T3CODE_POSTHOG_HOST` and `T3CODE_POSTHOG_KEY`; otherwise leave it disabled.
- **T3 Connect replacement, if required:** the relay source is in `infra/relay`, but its current
  deployment uses Clerk, Cloudflare, PlanetScale, and optional APNs/FCM. Operating it and
  rebuilding every client for its URL is a separate project. Direct pairing avoids this entire
  control plane if account-based discovery, managed tunnels, and relay notifications are not
  required.

Do not call the fork strictly independent until these reachable paths are either replaced,
disabled, or shown unreachable by an egress test. A source search is an inventory, not proof of
runtime behavior.

## Cutover and rollback

1. Back up the official home after stopping every official server that uses it. Preserve the
   backup's permissions and protect its tokens and secrets. Do not symlink a live home into the
   fork. Start the fork from a copy, not from the original.
2. Confirm the fork opens the copied projects and threads, starts a new turn, and can reconnect
   from each own-build client using direct pairing. Verify scheduled tasks and remote links
   explicitly: the dev migration tool drops them, while a complete offline copy retains state
   whose external effects must be reviewed before enabling it.
3. Disable the old service's startup and stop using the official mobile and hosted web clients.
   Only after the fork has passed the acceptance checks should its service be made persistent.
4. To roll back, stop the fork, restore or reopen the untouched pre-migration official home with
   the original official version, and re-enable its service. Never point an older official build
   at data already migrated by the fork.

For acceptance, capture the fork commit and client versions, a successful direct reconnect from
web, desktop, and mobile, and outbound DNS/proxy logs while pairing, starting a turn, opening
links, and checking updates. The logs should show no request to T3-operated domains or upstream
release/model-manifest endpoints. Check again after every new build; embedded endpoints differ
across clients and release channels.
