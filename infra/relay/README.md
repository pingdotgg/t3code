# T3 Connect Relay

> [!NOTE]
> Sign in to T3 Connect from the app under Settings > Sharing & access.

The relay is the hosted control plane for T3 Connect. It helps clients discover and connect to
remote environments, manages the cloud-side records needed for those connections, and delivers
optional mobile notifications and Live Activities.

The relay is intentionally not in the hot path for normal T3 Code traffic. After a client connects,
regular API and WebSocket traffic goes directly between that client and the selected environment.
See the [T3 Connect architecture note](../../docs/internals/t3-connect.md) for the larger system
design.

## Responsibilities

The relay currently owns:

- Linking T3 Code environments to a cloud account.
- Provisioning and tracking managed environment endpoints.
- Issuing short-lived credentials used to connect clients to linked environments.
- Listing linked environments and registered mobile devices for an account.
- Registering mobile notification preferences and APNs or FCM tokens.
- Receiving published agent activity and delivering notifications or Live Activity updates.
- Persisting relay state and exposing relay-specific traces for diagnostics.

The environment server and relay have separate credentials and trust boundaries. Read
[Environment Authentication Profile](../../docs/internals/environment-auth.md) before changing token,
credential, or authorization behavior.

## Code Map

- [`alchemy.run.ts`](./alchemy.run.ts) defines the deployed Alchemy stack.
- [`src/worker.ts`](./src/worker.ts) wires Cloudflare bindings, runtime layers, queues, and HTTP APIs.
- [`src/http/Api.ts`](./src/http/Api.ts) contains the relay HTTP handlers and authentication
  boundaries.
- [`src/environments`](./src/environments) contains environment linking, credentials, endpoint
  provisioning, and connection flows.
- [`src/agentActivity`](./src/agentActivity) contains mobile device registration, activity state,
  APNs and FCM delivery, and queue processing.
- [`src/auth`](./src/auth) contains relay token and DPoP proof handling.
- [`src/persistence/schema.ts`](./src/persistence/schema.ts) defines persisted relay state. Keep
  schema and migration changes together.

Shared request and response schemas live in
[`packages/contracts/src/relay.ts`](../../packages/contracts/src/relay.ts). Shared client-side relay
calls live in
[`packages/client-runtime/src/relay/managedRelay.ts`](../../packages/client-runtime/src/relay/managedRelay.ts).

## Working Locally

Install dependencies from the repository root, then run relay-focused checks from this directory:

```sh
vp install
cd infra/relay
vp test run
vp run typecheck
```

To run a smaller test set while iterating:

```sh
vp test run src/environments/EnvironmentLinker.test.ts
```

Before considering a change complete, run the repository-wide checks from the root:

```sh
vp check
vp run typecheck
```

Backend changes should include tests. Prefer testing the real business logic with external
dependencies represented at their boundary rather than mocking internal behavior.

## Deployment

The relay deploys with the Alchemy CLI (`vp run --filter t3code-relay deploy` is `alchemy deploy`
in this directory):

```sh
vp run --filter t3code-relay deploy
```

The stack provisions the Cloudflare Worker and queues, managed endpoint resources, database
connectivity, and relay tracing resources. Copy [`infra/relay/.env.example`](./.env.example) to
`infra/relay/.env` and fill in the deployment-specific values before deploying. Alchemy loads that
file from the relay directory. Runtime secrets include Clerk, APNs, and optional FCM credentials. Set
`APNS_ENABLED=false` for an Android-only development deployment without Apple credentials. Production adopts
the configured API and tunnel DNS zones as retained Cloudflare resources. Personal stages reference
the production-owned zones.

The `prod` Alchemy stage owns the retained PlanetScale database and is the shared hosted relay for
stable and nightly clients. Every other stage references that database and provisions an isolated
PlanetScale branch and runtime role for local development, so deploy `prod` before creating
developer stages:

```sh
vp run --filter t3code-relay deploy -- --stage prod
vp run --filter t3code-relay deploy -- --env-file .env.local
```

Alchemy defaults personal deployments to the `dev_$USER` stage. Relay custom domains apply the same
DNS-safe sanitization as Alchemy physical resource names, so `prod` uses
`relay.<RELAY_API_ZONE_NAME>` and `dev_julius` uses
`relay-dev-julius.<RELAY_API_ZONE_NAME>`. Managed environment endpoints are provisioned below
`RELAY_TUNNEL_ZONE_NAME`, which may be a different Cloudflare zone. Production tunnel hostnames use
`prod-<digest>.<RELAY_TUNNEL_ZONE_NAME>`; personal stages use
`<stage>-<digest>.<RELAY_TUNNEL_ZONE_NAME>`. `RELAY_DOMAIN` remains available as an explicit API
domain override.

The stack's `PublishClientConfig` action ([`src/clientConfig.ts`](./src/clientConfig.ts)) writes the
deployed relay URL and tracing configuration into the repository-root `.env`, so subsequent source
builds point at the relay that was just deployed without copying values manually. It runs only when
one of those outputs changed, and `T3CODE_RELAY_CLIENT_CONFIG_ENV` redirects it to another file.

### Running on free plans

Three switches replace the paid dependencies. Unset or empty keeps the defaults above.

- `RELAY_DATABASE_PROVIDER=external` uses the Postgres at `RELAY_DATABASE_URL` as the
  Hyperdrive origin instead of PlanetScale. Give it the direct, non-pooled URL (for Neon, the
  connection string without `-pooler`), ideally in AWS `us-west-2`, next to the Worker's placement.
  Alchemy does not migrate it: run `vp run --filter t3code-relay migrate:external-db` before each
  deploy, which applies `migrations/postgres` with the same `relay_migrations` bookkeeping. CI does
  this for you. An external database has no per-stage branches, so this mode deploys only `prod`.
  Alchemy binds every value the Worker reads at startup, so the URL is also a Worker secret.
- `RELAY_OBSERVABILITY=off` creates no Axiom datasets, tokens, monitors, or dashboard and no R2
  source-map bucket. The relay exports no spans, accepts and drops mobile crash reports, and
  publishes empty tracing settings, which leaves client tracing off.
- `RELAY_RATE_LIMIT=off` drops the Workers Rate Limiting bindings, whose Free plan availability
  Cloudflare does not document. Webhook and mobile telemetry requests are then not rate limited.

With all three, the deploy needs only Cloudflare and Clerk credentials. Workers Free allows 10 ms of
CPU per request and cron run and 50 subrequests per invocation, so watch for exceeded-CPU errors.

### Deployment CI

The relay is versioned separately from client releases. `.github/workflows/deploy-relay.yml` deploys
the shared Alchemy `prod` stage on every push to `main`. Stable and nightly release builds both
resolve their static public config from the same
`production` GitHub environment. Labeling a same-repository PR `relay:preview` deploys a `pr-<number>`
stage, and the cleanup workflow tears it down; see
[`relay-preview.yml`](../../.github/workflows/relay-preview.yml). Developers can
deploy personal non-production stages locally with any stage name other than `prod`.

The repository must define these Actions variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `PLANETSCALE_ORGANIZATION`
- `AXIOM_ORG_ID`

The repository must define these Actions secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `PLANETSCALE_API_TOKEN_ID`
- `PLANETSCALE_API_TOKEN`
- `AXIOM_TOKEN`

The PlanetScale and Axiom values are needed only while the [free-plan switches](#running-on-free-plans)
keep their defaults.

The `production` GitHub environment must define these Actions variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `RELAY_DOMAIN` if overriding the derived production relay domain
- `RELAY_ALERT_NOTIFIER_ID`, the Axiom notifier that relay alerts page. Without it the deployment
  creates no monitors or health dashboard. See
  [Relay alerts](../../docs/operations/relay-observability.md#alerts).
- `RELAY_WARNING_NOTIFIER_ID`, optional, the Axiom notifier for relay warnings
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`
- `RELAY_DATABASE_PROVIDER`, `RELAY_OBSERVABILITY`, and `RELAY_RATE_LIMIT`, optional; see
  [Running on free plans](#running-on-free-plans)

The `production` GitHub environment must define these Actions secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`
- `FCM_SERVICE_ACCOUNT` when Android push is enabled
- `RELAY_DATABASE_URL` when `RELAY_DATABASE_PROVIDER=external`
- `T3CHAT_LINK_SECRET`, optional, shared with T3 Chat's `T3CODE_LINK_SECRET`. Without it the
  T3 Chat account link is off. Local and preview stages can set `T3CHAT_URL` to point
  at another T3 Chat deployment; production uses `https://t3.chat`.

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. The production deployment uses an Axiom personal access token,
so `AXIOM_ORG_ID` must accompany `AXIOM_TOKEN`. The release workflow reads the production relay's
derived public URL and Clerk publishable key from the same environment for downstream desktop, CLI,
and hosted web builds.

See:

- [T3 Connect setup](../../docs/operations/connect-setup.md) for Clerk keys, JWT templates, and sign-up restrictions.
- [Relay Observability](../../docs/operations/relay-observability.md) for deployment tracing and diagnostics.
- [T3 Connect architecture](../../docs/internals/t3-connect.md) for environment linking and trust boundaries.
