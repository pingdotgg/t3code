# Railway provider — 0 → 100

This is the durable process for bringing Railway from zero to
Fly/Hetzner-comparable DX. It is also the post-mortem of Fly, so
we do not repeat those mistakes.

Do **not** invent a `processes/Railway/catalog.md` that goes stale.
The catalog lives in this file. Status updates happen here.

**Assess-first.** Partial work already exists under
`packages/alchemy/src/Railway/` and `packages/alchemy/test/Railway/`.
List those dirs, read the files, **FINISH** rather than rewrite.
Do **not** rewrite `Project.ts`, `Postgres.ts`, or `Service.ts` from
scratch.

---

## What Fly 0 → 100 actually required

Fly was not "write resources then tests." The working order, which
this Railway bring-up must follow, is:

1. **Distilled SDK DX first.** One package (`@distilled.cloud/fly-io`).
   Callers `import * as Machines from "@distilled.cloud/fly-io/machines"`
   (and `mpg` / `addons` / `sprites`). Package root re-exports
   `export * from "./services/index.ts"` — **never**
   `export * as Services`. Operation names stay the vendor's unless
   they are broken (Fly Machines `Apps_list` → `listApps` via OpenAPI
   `operationId` patches). Add-ons are spec JSON + Smithy patches, not
   hand-written TS introspection.
2. **Error tags in distilled, never in alchemy.** Every
   `UnknownCloudflareError` / `UnknownFlyError` / `UnknownRailwayError`
   the tests hit becomes a typed tag (JSON Patch on the spec, then
   regenerate that service only). Alchemy `catchTag`s the tag. No
   `as { _tag }`, no status-code duck typing.
3. **Alchemy AuthProvider.** Token from env (`FLY_API_TOKEN`) or
   stored credentials. `fromAuthProvider` maps onto distilled
   `Credentials`. Profile `testing` method `env`. **No `skipIf` for
   missing creds** — the token is in Doppler `alchemy-v2` (dev).
4. **Environment + Catalog.** Resolve org/workspace once, cache it.
   Catalog helpers (`currentOrgSlug`, `findRegion`) are not resources.
5. **Resources, reconcilers, `list()` for nuke.** Observe-ensure-sync.
   No `if (output === undefined) create else update`. Physical names
   from `createPhysicalName` (never `Date.now()`). Ownership via
   metadata/labels **or** alchemy physical-name shape when the API
   has no labels. `list()` is filtered to owned rows so nuke does
   not enumerate the whole account.
6. **Bindings.** `Binding.Service` + HTTP layer. Runtime methods
   require `Alchemy.RuntimeContext`. Deploy-time
   ``host.bind`${resource}`(data)`` is a no-op under
   `__ALCHEMY_RUNTIME__`. Access-split Read / Write / ReadWrite when
   the API distinguishes. Shared `{Cap}Binding.ts` / `{Cap}Http.ts`
   stay **un-exported**.
7. **Hosted Effect programs.** `Fly.Service({ main })` bundles with
   rolldown, `build.install: ["pg"]` for CJS natives (Rolldown's
   `pg.Client` interop is `The superclass is not a constructor`),
   Docker image, push, Machine. Bootstrap sets
   `globalThis.__ALCHEMY_RUNTIME__ = true` **then** `await import`.
   `BunHttpServer({ hostname: "0.0.0.0" })`.
8. **Test fixtures.** File-based `main`, never inline `script`.
   `Test.make({ providers })`. `test.provider`. Start **and** end
   with `stack.destroy()`. `afterAll.skipIf(!!process.env.NO_DESTROY)`
   is allowed. Out-of-band verify via distilled. Typed wait-until-gone.
   ConnectPostgres: `yield* Fly.ConnectPostgres(Db)` then
   `Drizzle.Postgres(conn.connectionString)` then `db.execute` —
   **not** `withPgClient`, **not** `Effect.tryPromise`, **not**
   `Effect.orDie` on SQL.
9. **Examples** (`examples/fly-*`) that a human can `alchemy deploy`.
10. **Docs hub + tutorial + JSDoc → `pnpm docs:gen`.** Never edit
    `website/src/content/docs/providers/{Cloud}/*.md` by hand.
    Tutorial is one concept per `##` heading, `diff lang="typescript"`.
11. **Dual PRs.** Distilled PR (DX + error-tag patches + regenerate).
    Alchemy PR with a DX-centric description (one `###` heading +
    snippet per export, **no `#`/`##`**, `--body-file`) that **links
    the distilled PR**.

Green bar: suite green **and** `pnpm nuke --include 'Railway.*' --dry-run`
is empty. That is 100%.

---

## DX that shipped (copy this)

```ts
import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Drizzle from "alchemy/Drizzle/Postgres";
import * as Effect from "effect/Effect";

const Site = Fly.App("Site");
const Db = Fly.Postgres("Db", { region: "iad" });

export default class Api extends Fly.Service<Api>()(
  "Api",
  {
    app: Site,
    main: import.meta.url,
    region: "iad",
    build: { install: ["pg"] },
  },
  Effect.gen(function* () {
    const conn = yield* Fly.ConnectPostgres(Db);
    const db = yield* Drizzle.Postgres(conn.connectionString);
    return {
      fetch: Effect.gen(function* () {
        const rows = yield* db.execute("select 1 as ok");
        return HttpServerResponse.json({ rows });
      }),
    };
  }).pipe(Effect.provide(Fly.ConnectPostgresHttp)),
) {}
```

Flat `Fly.*` namespace. Resource-valued props accept the resource or
an Effect producing it (module-scope `const Site = Fly.App("Site")`).
No `Input<T>` in Props. No `export * as Services`. No Attach API.
No `Config.redacted` as the postgres binding.

Distilled (Railway):

```ts
import * as railway from "@distilled.cloud/railway";
yield* railway.projectCreate({ input });
```

Package root, no `./railway` subpath. Wire names stay GraphQL
(`projectCreate`, not `createProject`).

---

## File layout (Fly / Hetzner / Railway)

```
distilled/packages/{cloud}/
  src/index.ts              # export * from credentials, errors, services
  src/services/index.ts     # generated barrel (export * as railway from …)
  src/services/{svc}.ts     # generated — NEVER edit
  patches/{svc}/*.json      # RFC 6902 against Smithy (or OpenAPI pre-convert)
  scripts/convert.ts        # spec → Smithy + apply patches
  scripts/generate.ts       # Smithy → SDK

packages/alchemy/src/{Cloud}/
  AuthProvider.ts
  Credentials.ts
  Environment.ts
  Catalog.ts
  Metadata.ts | Labels.ts   # ownership stamps
  Providers.ts              # providers() layer — minimal insertions
  index.ts                  # barrel — minimal insertions
  {Resource}.ts             # contract + provider, co-located
  {Capability}.ts           # Binding.Service
  {Capability}Http.ts       # Layer
  {Capability}Binding.ts    # shared scaffolding, NOT exported
  hosted.ts                 # Effect-native Service runtime (unexported helpers ok)

packages/alchemy/test/{Cloud}/
  {Resource}.test.ts
  fixtures/{worker}.ts

examples/{cloud}-*
website/src/content/docs/{cloud}/   # hub, setup, tutorial, compute, data
website/src/content/docs/providers/{Cloud}/  # generated, do not edit
```

Railway is a **flat** tree: `packages/alchemy/src/Railway/<Name>.ts`.
Do not nest services under subfolders.

---

## Mistakes we will not repeat

| Mistake | Do this instead |
| --- | --- |
| `export * as Services` / `Railway.railway.op` | Flat GraphQL: `import * as railway from "@distilled.cloud/railway"` then `railway.projectCreate`. No `./railway` export. |
| Invent verb-first GraphQL names (`createProject`) | Keep wire names (`projectCreate`). Only patch when the generated name is broken (`Apps_list`) |
| `skipIf` for missing `FLY_API_TOKEN` / `RAILWAY_API_TOKEN` | Token is in Doppler. Fail loud |
| `Input<T>` on Props | Plain types. Engine wraps |
| Export `type Ref<T>` | Unexported `type Ref<T> = T \| Effect.Effect<T, never, Providers>` in the resource file. Never `Input<T>` in Props. Never export `Ref`. |
| `if (output === undefined) { create } else { update }` | One observe-ensure-sync reconciler. Catch `RailwayNotFound` as missing. |
| `Date.now()` in names | `createPhysicalName` or a constant |
| `withPgClient` / `Effect.tryPromise` / `Effect.orDie` on SQL | `ConnectPostgres` + `Drizzle.Postgres` + `db.execute` |
| Bundle `pg` into the image | `build.install: ["pg"]` so `bun install` puts the CJS constructor on disk |
| Static drizzle import at module top in the worker | Fine **after** `pg` is installed; the crash was CJS interop, not drizzle |
| Catch `UnknownRailwayError` / HTTP status | Patch distilled, then `catchTag` |
| Edit generated `src/services/railway.ts` | Patch + `bun scripts/convert.ts && bun scripts/generate.ts` |
| Edit generated provider markdown | JSDoc + `pnpm docs:gen` |
| PR body with `#` / `##`, or inline `--body "$(cat <<'EOF')"` | One `###` per export, `--body-file` |
| Recreate `processes/Fly/catalog.md` | Catalog stays in this file |
| Agents run `tsc` / `tsc -b` / `pnpm build` | Coordinator owns typecheck |
| Unbounded `Effect.retry` | `times ≤ 8–10`, per-test timeout `480000` |
| `export` of `{Cap}Binding.ts` / `{Cap}Http.ts` scaffolding | Keep internal (`RedisBinding.ts`, `BucketBinding.ts`, …) |
| Rewrite `Project` / `Postgres` / `Service` from scratch | Assess-first. Finish. `createProject` in `Project.ts` is already serialized. |

---

## Railway catalog

Auth: account/team token (`RAILWAY_API_TOKEN` or `RAILWAY_TOKEN`) as
`Authorization: Bearer`. Project tokens (`RAILWAY_PROJECT_TOKEN`) as
`Project-Access-Token` — Alchemy AuthProvider uses **account** tokens
(`RAILWAY_API_TOKEN`) so every operation is reachable. Distilled
already prefers account over project when both are set.

Workspace is **not** a resource. `me.workspace ?? me.workspaces[0]`
is the default, overridable with `workspaceId` on Project. Catalog
helpers (`currentWorkspace`, `findRegion`) live in `Catalog.ts`.

API: GraphQL v2 `POST https://backboard.railway.com/graphql/v2`.
SDK: `import * as railway from "@distilled.cloud/railway"` — one
flat GraphQL surface, operations on the package root. There is no
`./railway` export.

Statuses: `implemented` | `partial` | `missing`. Wave-1 resources
already exist — extend them, do not replace them.

Railway's own IaC (`defineRailway` / `.railway/railway.ts`, see
https://docs.railway.com/infrastructure-as-code/reference) is the
parity target for Service settings, databases, variable refs,
groups, and volumes.

### Implemented (wave 1 — comparable to Fly/Hetzner)

| Resource | Status | Distilled ops | Notes |
| --- | --- | --- | --- |
| `Railway.Project` | implemented | `projectCreate`, `project`, `projectUpdate`, `projectDelete`, `projects` | Fly.App analogue. Owns environments + services. Name unique per workspace. `primaryEnvironmentId` / `baseEnvironmentId` captured. Changing `name` updates in place. Changing `workspaceId` replaces. **`createProject` in `Project.ts` is already serialized** (one create per 30s per workspace — process-wide semaphore + 31s sleep after success + retry `RailwayRateLimited`). Call that helper; do not open a second create path. |
| `Railway.Environment` | implemented | `environmentCreate`, `environment`, `environmentRename`, `environmentDelete`, `environments` | File is `ProjectEnvironment.ts`. Production env is created with the Project — do **not** duplicate it. Extra envs (staging) are this resource. `sourceEnvironmentId` forks. |
| `Railway.Service` | implemented | `serviceCreate`, `service`, `serviceUpdate`, `serviceInstance`, `serviceInstanceUpdate`, `serviceInstanceDeployV2`, `serviceDomainCreate` | Image **or** Effect-native (`main`) **or** GitHub `repo`. Hosted path: bundle + Docker + push to `registry` then `source.image`. Public `*.up.railway.app` via `serviceDomainCreate`. IaC parity: `healthcheck`/`healthcheckPath`, `healthcheckTimeout`, `replicas`, `buildCommand`, `startCommand`, `cronSchedule`, `repo`/`branch`/`rootDirectory`. |
| `Railway.Variable` | implemented | `variableUpsert`, `variableDelete`, `variables` | Fly.Secret analogue. Project- or service-scoped. Value is Redacted, never in attributes. `Railway.ref` emits `${{Service.VAR}}` / `${{shared.NAME}}`. |
| `Railway.Volume` | implemented | `volumeCreate`, `volumeUpdate`, `volumeDelete`, `volumeInstance`, `volumeInstanceUpdate` | Block disk. Attach via `serviceId` or `MountVolume`. |
| `Railway.CustomDomain` | implemented | `customDomainCreate`, `customDomain`, `customDomainDelete`, `customDomainUpdate` | User hostname on a Service. |
| `Railway.TcpProxy` | implemented | `tcpProxyCreate` (deprecated, **keep**), `tcpProxies`, `tcpProxyDelete` | Public TCP for Postgres/Redis/MySQL/Mongo. Convert skips deprecated fields — convert.ts re-includes `tcpProxyCreate`. |
| `Railway.Postgres` | implemented | `serviceCreate` + volume + variables + optional TcpProxy | Official image `ghcr.io/railwayapp-templates/postgres-ssl:16`. Sets `POSTGRES_*` + `DATABASE_URL`. Private URL `{name}.railway.internal`. Do not rewrite. |
| `Railway.Redis` | implemented | `serviceCreate` + variables | Image `redis:7`. `REDIS_URL`. |
| `Railway.Bucket` | implemented | `bucketCreate`, `bucketUpdate`, `bucketS3Credentials` | S3-compatible. Bindings reuse `@distilled.cloud/aws/s3` like Tigris. |
| AuthProvider (env / stored / oauth) | implemented | `loginSessionCreate`, `loginSessionVerify`, `loginSessionConsume`, `loginSessionAuth`, `loginSessionCancel` | `RAILWAY_API_TOKEN` env, stored token, or CLI login session (`method: "oauth"`). |
| Catalog / Metadata / Credentials / Environment | implemented | `me`, `regions` | Workspace + region helpers. Not resources. |

### Bindings (implemented)

| Binding | Status | Host | Runtime |
| --- | --- | --- | --- |
| `ConnectPostgres` | implemented | Service | `connectionString` from `DATABASE_URL` / `RAILWAY_POSTGRES_*`. Deploy-time `variableUpsert` of Railway reference `${{Postgres.DATABASE_URL}}` plus packed URI. |
| `ReadRedis` / `WriteRedis` / `ReadWriteRedis` | implemented | Service | RESP over `REDIS_URL`, same shape as Fly. |
| `PutObject` / `GetObject` / `DeleteObject` / `HeadObject` / `ListObjectsV2` | implemented | Service | S3 against bucket credentials. |
| `MountVolume` | implemented | Service | `{ path, volumeId }` into `ServiceBinding.mounts`; reconcile attaches via `volumeCreate`/`volumeInstanceUpdate`. |
| `GetVariable` (optional) | missing | Service | Read a Variable by name from env. Prefer `Config.redacted` for `.env`. |

Shared scaffolding (`RedisBinding.ts`, `RedisHttp.ts`, `BucketBinding.ts`)
is **not** exported from `index.ts`. Keep it that way.

### IaC parity (in scope — Railway's `defineRailway` surface)

Parity with https://docs.railway.com/infrastructure-as-code/reference.
These are first-class catalog items, not a skip list.

| Item | Status | Distilled ops | Notes |
| --- | --- | --- | --- |
| Service `healthcheck` / `healthcheckTimeout` | implemented | `serviceInstanceUpdate` (`healthcheckPath`, `healthcheckTimeout`) | IaC: `healthcheck: "/health"`, `healthcheckTimeout: 30`. Props `healthcheck` (alias) and `healthcheckPath` on `Service`. Observe via `serviceInstance`. |
| Service `replicas` | implemented | `serviceInstanceUpdate` (`numReplicas`, `multiRegionConfig`) | IaC: `replicas: 3` or `{ "us-west2": 2, "europe-west4": 1 }`. |
| Service GitHub `repo` source | implemented | `serviceCreate`/`serviceInstanceUpdate` `source.repo` | IaC: `source: github("owner/repo", { branch: "main" })`. Image and `main` already work. GitHub App entitlement is `RailwayForbidden`; lifecycle opt-in `RAILWAY_TEST_GITHUB=1`. |
| Service `cron` | implemented | `serviceInstanceUpdate` (`cronSchedule`) | IaC/cron jobs. Observed as `cronSchedule` / `nextCronRunAt`. |
| Service `build` / `start` commands | implemented | `serviceInstanceUpdate` (`buildCommand`, `startCommand`) | Distinct from hosted `build: { install }` (bundler). IaC: `build: "pnpm build"`, `start: "pnpm start"`. |
| `Railway.MySQL` | implemented | `serviceCreate` + volume + variables + optional TcpProxy | Same shape as Postgres. Official `mysql` image. Vars `MYSQLHOST`/`MYSQLPORT`/`MYSQLUSER`/`MYSQLPASSWORD`/`MYSQLDATABASE`/`MYSQL_URL` (+ public TCP `MYSQL_PUBLIC_URL`). Mount `/var/lib/mysql`. IaC alias `Railway.mysql`. |
| `Railway.Mongo` | implemented | `serviceCreate` + volume + variables + optional TcpProxy | Official `mongo` image. Start command binds IPv6: `mongod --ipv6 --bind_ip ::,0.0.0.0`. Vars `MONGOHOST`/`MONGOPORT`/`MONGOUSER`/`MONGOPASSWORD`/`MONGO_URL` (+ `MONGO_PUBLIC_URL`). Mount `/data/db`. IaC alias `Railway.mongo`. |
| `Railway.VolumeBackup` | implemented | `volumeInstanceBackupCreate`, `volumeInstanceBackupList`, `volumeInstanceBackupLock`, `volumeInstanceBackupRestore`, `volumeInstanceBackupDelete`, `volumeInstanceBackupScheduleList`, `volumeInstanceBackupScheduleUpdate` | Manual snapshots + `DAILY`/`WEEKLY`/`MONTHLY` schedules. Restore is destructive. Pro-plan gated (`RailwayForbidden`); lifecycle opt-in `RAILWAY_TEST_VOLUME_BACKUP=1`. |
| `Railway.ref` | implemented | `variableUpsert` values | Helper that emits `${{ServiceName.VAR}}` / `${{shared.NAME}}`. Distinct from the **unexported** resource-prop `type Ref<T>`. Do not export `Ref`. |
| `Railway.Group` | implemented | `project.groups`, `environmentPatchCommit` (`EnvironmentConfig.groups` / `services[id].groupId`), `environment.canvasGroupRefs` | IaC: `group("Backend", [api, worker, db])`. Canvas organization only. |
| `Railway.PrivateNetwork` | implemented | `privateNetworkCreateOrGet`, `privateNetworks`, `privateNetworkEndpoint`, `privateNetworkEndpointCreateOrGet`, `privateNetworkEndpointRename`, `privateNetworkEndpointDelete`, `privateNetworkEndpointNameAvailable`, `privateNetworksForEnvironmentDelete` | Mesh is on by default (`*.railway.internal`). Resource covers named networks + per-service endpoints (custom DNS names). |

### Previously skipped — now in scope

The old "out of scope" list that named billing/usage, OAuth login
sessions, audit logs, marketplace templates, canvas Functions,
sandboxes, and cloud agents is **deleted**. Those are resources
(or AuthProvider methods) to implement.

| Resource | Status | Distilled ops | Notes |
| --- | --- | --- | --- |
| `Railway.Usage` | implemented | `usage`, `estimatedUsage` | Billing/usage helper (`Railway.usage` / `Railway.estimatedUsage`). Measurements + optional `groupBy`. Read-oriented; `list()` not required. |
| `Railway.UsageLimit` | implemented | `usageLimitSet`, `usageLimitRemove` | Soft/hard dollar caps (`softLimitDollars`, `hardLimitDollars`) on a customer. Remove is idempotent. |
| AuthProvider oauth | implemented | `loginSessionCreate`, `loginSessionVerify`, `loginSessionConsume`, `loginSessionAuth`, `loginSessionCancel` | CLI-style login session: create → print pairing URL → poll verify/consume → store token as `method: "oauth"`. `env` / `stored` unchanged. Tests cover GraphQL create+cancel (no browser). |
| `Railway.AuditLog` | implemented | `auditLog`, `auditLogs`, `auditLogEventTypeInfo` | Query-only helper (`Railway.AuditLog` / `listAuditLogs` / `getAuditLog`). Nothing to reconcile. |
| `Railway.Template` | implemented | `template`, `templates`, `templateDeployV2`, … | Marketplace + user templates. Deploy with `templateDeployV2` (serialized config). |
| `Railway.Function` | implemented | `functionRuntime`, `functionRuntimes`, `serviceCreate`, `serviceInstanceUpdate`, `serviceInstanceDeployV2` | Canvas Functions: a Service that runs a **single TypeScript file** on the Bun function runtime. Distinct from Effect-native `Service({ main })`. |
| `Railway.Sandbox` | implemented | `sandboxCreate`, `sandbox`, `sandboxes`, `sandboxDestroy`, `sandboxExec`, `sandboxHeartbeat`, checkpoints | Ephemeral Linux VMs. Heartbeat extends TTL. Priority Boarding; create probe pins `RailwayForbidden`. |
| `Railway.CloudAgent` | implemented | `cloudAgentCreate`, `cloudAgent`, `cloudAgents`, `cloudAgentDelete`, `cloudAgentSleep`, `cloudAgentWake` | Coding agent VM in an environment. Sleep keeps the volume; wake re-runs the entrypoint. |

ConnectPostgres / Redis / S3 / MountVolume stay as they are.
`ConnectMySQL` / `ConnectMongo` match `ConnectPostgres`.

---

## Distilled Railway rules

- Package stays `@distilled.cloud/railway`.
- `src/index.ts`: `export * from "./services/railway.ts"`. One GraphQL
  service, so ops are on the package root. `package.json` `exports`
  is only `"."` — no `./railway`, `./Credentials`, `./Retry`, etc.
- Callers: `import * as railway from "@distilled.cloud/railway"` then
  `railway.projectCreate({ input })`. GraphQL field names are the
  spec. **Do not** patch them to verb-first.
- `convert.ts` applies `patches/railway/*.json` to the **Smithy**
  model after GraphQL→Smithy (same as Fly addons). Keep
  `tcpProxyCreate` even though it is deprecated.
- Errors are client-wide (`RAILWAY_ERROR_CODE_MAP` in `errors.ts`)
  because GraphQL has no per-field error contract. New
  `extensions.code` values go in that map. Message-only failures
  that tests hit get a matcher in `protocol.ts` **or** a dedicated
  class + map entry. Then regenerate. Alchemy never catches
  `UnknownRailwayError`.
- Agents regenerate **only** railway:
  `cd distilled/packages/railway && bun scripts/convert.ts && bun scripts/generate.ts && pnpm exec oxfmt src/services/railway.ts`.
  Never `tsc` / `tsc -b` / `pnpm build`. Never edit generated
  `src/services/railway.ts` by hand.

---

## Alchemy Railway rules

- Flat `Railway.*`. `import * as Railway from "alchemy/Railway"`.
- Files live at `packages/alchemy/src/Railway/<Name>.ts`.
- `providers()` registers every resource + Auth + Credentials +
  Environment + binding HTTP layers + FetchHttpClient, `Layer.orDie`.
  Shared files (`Providers.ts`, `index.ts`): **one minimal insertion**,
  re-read first, retry on conflict. Never rewrite wholesale.
- Reconciler doctrine (observe → ensure → sync → return). Catch
  `RailwayNotFound` as missing. Catch already-exists races and
  continue. **No create/update branch on `output === undefined`.**
- Resource-valued props: unexported
  `type Ref<T> = T | Effect.Effect<T, never, Providers>`.
  Never `Input<T>` in Props. Never export `Ref`.
- Effect 4. No `async`/`await`. No `Effect.orDie` in lifecycle.
- `list()` on Project (and children via project) so nuke is scoped.
- Project create is **1 per 30s per workspace**. Always go through
  `createProject` in `Project.ts` (already serialized). Do not add a
  parallel `projectCreate` call.
- Tests, from repo root:

  ```sh
  timeout 480 doppler run --project alchemy-v2 --config dev -- pnpm test test/Railway/<File>.test.ts --profile testing --retry 0
  ```

  Per-test timeout `480000`. `test.provider`. `stack.destroy()` at
  **start and end**. No `Date.now()`. No `skipIf` for
  `RAILWAY_API_TOKEN`. `skipIf` only for a typed entitlement error
  with the exact tag. `afterAll.skipIf(!!process.env.NO_DESTROY)` is
  allowed. Out-of-band via distilled `railway.project({ id })` etc.
- Postgres/Redis/MySQL/Mongo from the test process may use the
  public TcpProxy URL. In-Service bindings use the private
  `*.railway.internal` URL packed into env.
- Effect-native Service: same `build.install` footgun as Fly. Copy
  Fly `hosted.ts` bootstrap (runtime flag **before** import, bind
  `0.0.0.0`, `build.install` for `pg`). Already implemented —
  extend, do not rewrite.
- Image-based Service (`image: "hashicorp/http-echo"`) is the
  lifecycle test that does not need a push registry. `main` is the
  Fly-comparable path and needs a registry Railway can pull
  (`registry` prop → GHCR / Docker Hub). Tests must not `skipIf` the
  image path.
- Do not export Binding scaffolding files.

---

## Workflow (coordinator)

1. Distilled DX + patches hook + `tcpProxyCreate` keep + regenerate.
2. Auth → Credentials → Environment → Catalog → Metadata.
3. Project (with `list`) → Environment resource → Variable.
4. Service (image + hosted) → ServiceDomain → Volume → MountVolume
   → TcpProxy → CustomDomain.
5. Postgres → Redis → Bucket + bindings + fixtures.
6. **IaC parity on existing Service** (healthcheck, replicas, repo,
   cron, build/start). `Railway.ref`. MySQL. Mongo. VolumeBackup.
   Group. PrivateNetwork.
7. **Previously skipped, now in scope:** Usage / UsageLimit,
   AuthProvider oauth, AuditLog, Template, Function, Sandbox,
   CloudAgent.
8. Live tests, patch error tags as they surface, regenerate, retest.
   Three-iteration budget per resource, then skipIf-gate **platform**
   entitlement only (never creds). Command:
   `timeout 480 doppler run --project alchemy-v2 --config dev -- pnpm test test/Railway/<File>.test.ts --profile testing --retry 0`.
9. Examples + hub + tutorial + `pnpm docs:gen`.
10. Dual PRs. Alchemy body links distilled PR. DX-centric, snippets.
11. Coordinator `pnpm exec tsc -b`. Agents never typecheck (`tsc`,
    `tsc -b`, `pnpm build` are banned).

Shared files (`Providers.ts`, `index.ts`, `package.json`,
`astro.config.mjs`, `docs-tabs.ts`, `stacks/nuke.ts`): coordinator
edits, or agents make **one minimal insertion** and retry on
conflict.

Steps 1–5 are largely landed. New work starts at step 6. Do not
reimplement Project, Postgres, or Service.
