/**
 * Hyperdrive in local dev: the binding is a passthrough to the Connection's
 * `dev` origin (there is no SQL simulator), so it needs a REAL reachable
 * Postgres. The stack only includes this worker when `HYPERDRIVE_DEV_URL`
 * is set, e.g.:
 *
 * ```sh
 * docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
 * HYPERDRIVE_DEV_URL=postgres://postgres:postgres@localhost:5432/postgres bun test
 * ```
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/Postgres";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const parseOrigin = (raw: string | undefined) => {
  // The fallback keeps module evaluation safe inside workerd (where the env
  // var doesn't exist); the worker only deploys when the var is set.
  const url = new URL(raw ?? "postgres://user:pass@localhost:5432/postgres");
  return {
    scheme: "postgres" as const,
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: url.pathname.slice(1) || "postgres",
    user: decodeURIComponent(url.username),
    password: Redacted.make(decodeURIComponent(url.password)),
  };
};

/**
 * The `dev` origin is what the local passthrough binding connects to;
 * `origin` is what a live deploy would use. This example points both at the
 * same database. `sslmode: "disable"` suits a local Docker Postgres — adapt
 * if your dev database requires TLS.
 */
export const DevPostgres = Effect.gen(function* () {
  const origin = parseOrigin(process.env.HYPERDRIVE_DEV_URL);
  return yield* Cloudflare.Hyperdrive.Connection("DevPostgres", {
    origin,
    caching: { disabled: true },
    dev: { ...origin, sslmode: "disable" },
  });
});

export default class HyperdriveWorker extends Cloudflare.Worker<HyperdriveWorker>()(
  "HyperdriveWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(DevPostgres);
    const sql = yield* SQL.Postgres({ url: hyperdrive.connectionString });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://internal");
        if (url.pathname === "/query") {
          const rows = (yield* sql`
            SELECT 1 + 1 AS sum, current_database() AS db
          `) as ReadonlyArray<{ sum: number; db: string }>;
          return yield* HttpServerResponse.json({ row: rows[0] });
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
