# @alchemy.run/better-auth

[Better Auth](https://better-auth.com) for [alchemy](https://alchemy.run) — an Effect-native wrapper plus a pluggable database layer per platform.

```typescript
import { BetterAuth } from "@alchemy.run/better-auth";
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Cloudflare from "alchemy/Cloudflare";

export const AuthDb = Cloudflare.D1.Database("AuthDb");

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const auth = yield* BetterAuth({
      basePath: "/auth",
      emailAndPassword: { enabled: true },
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/auth")) {
          return yield* auth.fetch; // the Better Auth HTTP surface
        }
        const session = yield* auth.getSession(); // null when anonymous
        return yield* HttpServerResponse.json({ user: session?.user ?? null });
      }),
    };
  }).pipe(Effect.provide(CloudflareD1(AuthDb))),
) {}
```

What you get:

- **`yield* BetterAuth(options)`** — full `Auth<Options>` type inference: plugins you pass show up on `auth.api`, `Session` types flow from your options. No tags, no casts.
- **`auth.api.*`** — every Better Auth endpoint as an Effect with a typed `BetterAuthApiError` failure (`status`, `statusCode`, `body.code`, and `headers` *including* the `set-cookie` headers better-call hides on a symbol). Non-`APIError` throws are defects.
- **`auth.fetch`** — an alchemy `HttpEffect` serving the Better Auth routes; works on Cloudflare Workers and AWS Lambda unchanged.
- **`auth.getSession()`** — typed session lookup from the ambient request (or explicit `Headers`); resolves `null` for anonymous.
- **`auth.auth`** — the raw per-execution `Auth` instance as an escape hatch.
- **Automatic schema migrations at deploy** — an internal alchemy Action applies Better Auth's schema (plugins included) during `alchemy deploy`, re-running only when the schema or target database changes. Opt out with `migrate: false`.
- **Managed secret** — `secret` defaults to a stable auto-provisioned `Alchemy.Random` value bound into the host environment.

The database is a Layer you provide on the surrounding impl effect. Pick the optimal layer for your environment → database pair — HTTP/serverless drivers where they exist, TCP drivers as the fallback:

| Runtime | Database | Layer | Transport |
| --- | --- | --- | --- |
| Cloudflare Worker | D1 | `CloudflareD1` | native binding |
| Cloudflare Worker / AWS Lambda | Neon | `Neon` | serverless driver (WebSocket) |
| AWS Lambda | Aurora | `AuroraDataApi` | RDS Data API (HTTPS, IAM) |
| Cloudflare Worker | any TCP Postgres/MySQL | `CloudflareHyperdrive` | pooled TCP via Hyperdrive |
| anywhere with sockets | any Postgres | `Postgres` | `pg` TCP |
| anywhere with sockets | any MySQL (e.g. PlanetScale) | `MySQL` | `mysql2` TCP |
| bun (dev/tests) | local file | `SQLite` | `bun:sqlite` |
| tests | in-memory | `Memory` | — |
| bring-your-own | your Drizzle db | `Drizzle` | yours |

Every layer routes runtime access through alchemy's binding system — native bindings (D1, Hyperdrive, RDS Data API IAM grants) or host-environment Output bindings (connection strings) — never hand-wired env vars.

## Cloudflare D1

Native D1 binding at runtime; migrations run over the D1 HTTP API at deploy (and against the local simulator under `alchemy dev`).

```typescript
import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Cloudflare from "alchemy/Cloudflare";

export const AuthDb = Cloudflare.D1.Database("AuthDb");

Effect.gen(function* () {
  const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
  // ...
}).pipe(Effect.provide(CloudflareD1(AuthDb)));
```

## Neon

Neon's serverless driver speaks WebSocket from the edge — no Hyperdrive, no `pg`, no TCP sockets. The optimal pairing for both Workers and Lambda (`@neondatabase/serverless` is an optional peer).

```typescript
import { Neon as NeonDatabase } from "@alchemy.run/better-auth/Neon";
import * as Neon from "alchemy/Neon";

export const AuthDb = Neon.Project("AuthDb");

Effect.gen(function* () {
  const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
  // ...
}).pipe(
  Effect.provide(
    Layer.unwrap(Effect.map(AuthDb, (db) => NeonDatabase(db.connectionUri))),
  ),
);
```

## Aurora (RDS Data API)

SQL over HTTPS with IAM auth — no VPC attachment for the Lambda, no drivers, no pools. Runtime access flows through the `AWS.RDSData.*` bindings (which grant `rds-data:*` + `secretsmanager:GetSecretValue` on the host); deploy-time migrations use the same Data API with the stack's credentials. `kysely` and `@distilled.cloud/aws` are optional peers.

```typescript
import { AuroraDataApi } from "@alchemy.run/better-auth/AuroraDataApi";
import * as AWS from "alchemy/AWS";

export const Db = AWS.RDS.Aurora("AuthDb", {
  subnetIds: network.privateSubnetIds,
  securityGroupIds: [securityGroup.groupId],
  // the Data API is enabled by default
});

Effect.gen(function* () {
  const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
  // ...
}).pipe(Effect.provide(AuroraDataApi(Db, { database: "postgres" })));
```

## Cloudflare Hyperdrive

Pooled Postgres (or MySQL) through a Hyperdrive connection. Hyperdrive's connection string only exists inside the Worker, so pass the *origin* URL for deploy-time migrations (or omit `migrate` to skip them).

```typescript
import { CloudflareHyperdrive } from "@alchemy.run/better-auth/CloudflareHyperdrive";

const branch = yield* Neon.Branch("auth-db", { project });
const hyperdrive = yield* Cloudflare.Hyperdrive.Connection("auth-hd", {
  origin: branch.origin,
});

Effect.gen(function* () {
  const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
  // ...
}).pipe(
  Effect.provide(
    CloudflareHyperdrive(hyperdrive, { migrate: branch.connectionUri }),
  ),
);
```

## Postgres (generic TCP)

The fallback for any Postgres you have a connection string for: PlanetScale Postgres (`role.connectionUrl`), Prisma Postgres (`connection.databaseUrl`), RDS inside a VPC, or a literal URL. One `pg` pool per execution, closed when the event settles. `pg` is an optional peer dependency. (Prefer `Neon`/`AuroraDataApi`/`CloudflareHyperdrive` when they match your pair.)

```typescript
import { Postgres } from "@alchemy.run/better-auth/Postgres";

const project = yield* Neon.Project("AuthDb");

Effect.gen(function* () {
  const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
  // ...
}).pipe(Effect.provide(Postgres(project.connectionUri)));
```

Resource Outputs are bound into the host environment at deploy and read back at runtime; the same source drives deploy-time migrations (override with `migrate:`, disable with `migrate: false`).

## MySQL (generic TCP)

Same shape as Postgres over `mysql2` (optional peer): PlanetScale MySQL, Hyperdrive MySQL origins, RDS MySQL. PlanetScale requires TLS — pass it in the URL's `ssl` query parameter.

```typescript
import { MySQL } from "@alchemy.run/better-auth/MySQL";

const password = yield* Planetscale.MySQLPassword("auth-db", { database, role: "admin" });
const url = `mysql://${password.username}:...@${password.host}/${database.name}?ssl=${encodeURIComponent('{"rejectUnauthorized":true}')}`;

Effect.gen(function* () {
  const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
  // ...
}).pipe(Effect.provide(MySQL(url)));
```

## AWS Lambda

No dedicated host layer needed — `auth.fetch` is host-portable. Serve it from a Lambda function URL with the database layer matching your target: `AuroraDataApi` for Aurora, `Neon` for Neon, or generic `Postgres`/`MySQL` (TCP drivers on Lambda need `build: { install: ["pg"] }` so the dynamically-imported driver ships with an npm layout).

```typescript
import * as Lambda from "alchemy/AWS/Lambda";
import { Neon as NeonDatabase } from "@alchemy.run/better-auth/Neon";

export const AuthDb = Neon.Project("AuthDb");

export class AuthFunction extends Lambda.Function<Lambda.Function>()("AuthFunction") {}

export default AuthFunction.make(
  // scrypt password hashing needs headroom over the 128 MB default
  { main, url: true, memorySize: 512, timeout: Duration.seconds(30) },
  Effect.gen(function* () {
    const auth = yield* BetterAuth({
      basePath: "/auth",
      emailAndPassword: { enabled: true },
    });
    return { fetch: /* route /auth/* to auth.fetch */ };
  }).pipe(
    Effect.provide(
      Layer.unwrap(Effect.map(AuthDb, (db) => NeonDatabase(db.connectionUri))),
    ),
  ),
);
```

## SQLite (local development)

`bun:sqlite`-backed layer for development and tests on the bun runtime.

```typescript
import { SQLite } from "@alchemy.run/better-auth/SQLite";

Effect.gen(function* () {
  const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
  // ...
}).pipe(Effect.provide(SQLite(".alchemy/auth.sqlite")));
```

## Memory (tests)

In-memory adapter; nothing persisted, no migrations needed.

```typescript
import { Memory } from "@alchemy.run/better-auth";

Effect.gen(function* () {
  const auth = yield* BetterAuth({
    emailAndPassword: { enabled: true },
    secret: "test-secret",
  });
  // ...
}).pipe(Effect.provide(Memory()));
```

## Drizzle

Bring your own Drizzle database via Better Auth's official `drizzleAdapter` (optional peer `drizzle-orm`). Schema is yours — generate it with `npx @better-auth/cli generate`; there is no automatic migration for this layer.

```typescript
import { Drizzle } from "@alchemy.run/better-auth/Drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./auth-schema.ts";

const db = drizzle(pool, { schema });

Effect.gen(function* () {
  const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
  // ...
}).pipe(Effect.provide(Drizzle(db, { provider: "pg", schema })));
```

## Handling errors

```typescript
const result = yield* auth.api
  .signInEmail({ body: { email, password } })
  .pipe(
    Effect.catchTag("BetterAuthApiError", (error) =>
      error.statusCode === 401
        ? Effect.succeed(null)         // wrong credentials
        : Effect.fail(error),
    ),
  );
```

`error.toResponse()` renders the failure exactly as Better Auth would have (status + JSON body + merged headers, `set-cookie` included) for pass-through handlers.

## Migrations

Every SQL layer migrates automatically during `alchemy deploy` via an internal alchemy Action:

- runs **only at apply** (never at plan, never inside the deployed runtime — the migration code is dead-code-eliminated from bundles),
- re-runs only when the auth schema (plugins, additional fields) or the target database changes,
- is additive and idempotent (`CREATE TABLE` / `ADD COLUMN` on what's missing).

Opt out with `migrate: false` and manage the schema yourself (`npx @better-auth/cli generate`). Multiple `BetterAuth` instances in one stack: give each a distinct `id` to disambiguate the secret + migration resources.
