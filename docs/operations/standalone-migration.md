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

## Prepare an isolated replacement

1. Pin a fork commit and build with the Node version required by its root `package.json`. Follow
   [development setup](./development.md#first-checkout) and the
   [source build example](../user/install.md#intel-macs). Keep a local copy of the build and its
   commit SHA. A source build can run the server with `node apps/server/dist/bin.mjs`; it does not
   use the official `t3` launcher or its update path.
2. Give the replacement its own T3 home. If there is official state to preserve, make a copy of
   that data. A staging copy made while the official server is running must use a consistent
   SQLite snapshot; the dev database migration tool intentionally drops tasks and links, so it is
   a test fixture, not a complete migration. For the final copy of existing state, stop the
   official desktop and service, confirm no server still owns the database, then copy the entire
   userdata directory, secrets, settings, and any needed `service.env` into the new home. Review
   copied configuration for T3 Connect and update endpoints before the fork starts. Keep the
   original home and an offline backup unchanged.
3. Run the forked environment with product telemetry disabled:

   ```dotenv
   T3CODE_TELEMETRY_ENABLED=false
   T3CODE_OTEL_SDK_DISABLED=true
   T3CODE_MODEL_MANIFEST_URL=off
   ```

   Set these in the process environment or the fork's `service.env` before it starts. The server
   otherwise defaults product telemetry to `https://ingest.t3.codes`; see
   [telemetry](../user/telemetry.md) and [service environment](../user/background-service.md#configure-the-service-environment).
   On fork revisions that support `T3CODE_MODEL_MANIFEST_URL`, `off` uses the bundled model
   catalog without a background fetch. An HTTPS URL can instead point to a catalog you operate.
   Older revisions fetch `model-manifest.json` from `pingdotgg/t3code` on GitHub before the
   provider update checks can be turned off in Settings; do not use them for a strict no-T3 build.

   For a foreground staging server built from a revision supporting that setting, use an absolute
   path to a copied, isolated home:

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

## Replace the client distributions

The repository's `.env.example` contains the production T3 relay URL. Do not copy it into a fork
build. On revisions supporting `T3CODE_STANDALONE`, set it to `1` for each client build and set
`GITHUB_REPOSITORY` or `T3CODE_DESKTOP_UPDATE_REPOSITORY` to your `owner/repo`. The build rejects
T3-operated relay, diagnostics, hosted-app, and mobile legal-site URLs, T3's Expo project ID, and
an upstream release repository. A build made without this switch retains the official defaults.

- **Web:** host the fork's static app at an HTTPS origin you control. Set
  `T3CODE_HOSTED_APP_URL` (also read as `VITE_HOSTED_APP_URL`) in the build and server only when
  you host it. With no hosted app, clients use direct pairing and native thread links. Leave
  relay, Clerk, and browser tracing values unset for direct-only use.
- **Desktop:** build and sign the fork's app under an identity you control. Set the fork release
  repository at build time. Disable automatic updates with `T3CODE_DISABLE_AUTO_UPDATE=true`
  until your feed is ready, or point the managed `updates.feedUrl` at your feed. The bundled
  server still needs the runtime settings above; the client build switch alone does not set them.
- **CLI and SSH hosts:** distribute the fork's server/CLI archive with its checksums.
  `T3CODE_RELEASE_BASE_URL` or a managed update mirror can redirect archive downloads, but the
  ordinary `t3 update` release-index path still refers to upstream. Do not use `t3 update`,
  `npx t3`, official install scripts, or desktop-managed SSH installation as a fork delivery
  mechanism until their release paths are redirected and tested.
- **Mobile:** build and distribute forked iOS/Android apps with your signing and identifiers.
  Set `T3CODE_EAS_PROJECT_ID` and `T3CODE_EAS_OWNER` only for an Expo project you operate;
  without them, standalone builds disable OTA updates. Set `EXPO_PUBLIC_MARKETING_SITE_URL`
  only for your legal site. Leave `T3CODE_RELAY_URL`, Clerk, and OTLP tracing values unset for
  direct-only use. Re-pair the new app to each environment and verify which local client state
  transfers before removing the official app.

The [release runbook](./release.md) describes the upstream signing, archive, and update-feed
formats. Reusing its workflow in a fork requires replacing upstream credentials, domains,
distribution destinations, and release ownership; a fork checkout alone does not change them.

## Remaining network dependencies to close in the fork

These paths need configuration, implementation, or an egress test before declaring independence:

- **Model manifest:** use `T3CODE_MODEL_MANIFEST_URL=off` on a revision that supports it, or point
  it at an HTTPS catalog you operate. With `off`, the bundled catalog and any newer disk cache
  remain available, but new compatibility information is not fetched.
- **Updates and installers:** make the CLI release index, desktop feed, npm launcher, installer
  scripts, and SSH runtime downloads use the fork's release source. Until then, keep automatic
  updates off and use controlled builds.
- **Links and fallbacks:** a standalone client build removes the ordinary hosted-app,
  download/legal, issue, prompt/thread, and crash-recovery links to T3. Audit less common routes
  such as T3 Connect account pages, the `t3.json` schema URL, MCP approval redirects, and
  provider sign-in return origins before using them.
- **Telemetry and diagnostics:** verify that the server, desktop, web, and mobile builds have no
  T3 ingest, relay tracing, or mobile Observe endpoint. Server opt-out alone does not control
  separate browser or mobile clients.
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
