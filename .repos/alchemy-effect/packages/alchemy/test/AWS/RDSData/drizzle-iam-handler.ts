import * as Lambda from "@/AWS/Lambda";
import * as RDS from "@/AWS/RDS";
import * as Drizzle from "@/Drizzle/index.ts";
import { sql } from "drizzle-orm";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";
import { RDSDataInfra } from "./infra.ts";

const main = path.resolve(import.meta.dirname, "drizzle-iam-handler.ts");

export class RDSDrizzleIamFunction extends Lambda.Function<Lambda.Function>()(
  "RDSDrizzleIamFunction",
) {}

/**
 * Lambda fixture for the `RDS.Connect` IAM-auth path (db-drivers §3
 * "RDS/Aurora"):
 *
 * - `auth: "iam"` — the deploy half binds `rds-db:connect` on the cluster's
 *   `dbuser:{resourceId}/app_iam`; the runtime half presigns a 15-minute
 *   token as the password (no Secrets Manager call).
 * - `subnetIds`/`securityGroupIds` attach THIS function to the fixture VPC
 *   through the Function binding contract's `vpc` channel (DECISION #5) —
 *   the isolated VPC is fine because IAM-auth needs zero AWS API calls at
 *   runtime (the presign is local; credentials come from the Lambda env).
 * - `Drizzle.Postgres(url)` proves the `ConnectionInfo.url` composition:
 *   the pool dials the cluster endpoint over a real socket per execution.
 *
 * Shares the Aurora infra with the RDSData fixture (`infra.ts`); the
 * `app_iam` user is bootstrapped by that fixture's `/setup-iam-user` route
 * (Data API), since this VPC-attached function cannot reach the Data API.
 */
export default RDSDrizzleIamFunction.make(
  {
    main,
    url: true,
    // First query per execution builds the pool + TLS handshake while the
    // serverless cluster may be scaling from idle.
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const { cluster, subnetA, subnetB, lambdaSecurityGroup } =
      yield* RDSDataInfra;

    const connect = yield* RDS.Connect(cluster, {
      auth: "iam",
      username: "app_iam",
      database: "app",
      subnetIds: [subnetA.subnetId, subnetB.subnetId],
      securityGroupIds: [lambdaSecurityGroup.groupId],
    });

    // `url` embeds the freshly minted token; the pool is per-execution
    // (ExecutionMemo), so every invoke re-runs `connect` and re-mints.
    const db = yield* Drizzle.Postgres(Effect.map(connect, (info) => info.url));

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Token-minting proof without opening a socket: the password is a
        // presigned `rds-db` URL (never echoed — only its shape), and
        // `refreshPassword` re-mints for serverful lazy-password hooks.
        if (request.method === "GET" && pathname === "/connect-info") {
          const info = yield* connect;
          const refreshed = info.refreshPassword
            ? Redacted.value(yield* info.refreshPassword)
            : undefined;
          return yield* HttpServerResponse.json({
            host: info.host,
            port: info.port,
            database: info.database,
            username: info.username,
            hasToken:
              typeof info.password === "string" &&
              info.password.includes("X-Amz-Signature="),
            ssl: info.ssl,
            canRefresh:
              refreshed !== undefined && refreshed.includes("X-Amz-Signature="),
          });
        }

        // Socket round-trip: IAM token auth + TLS + in-VPC connectivity.
        if (request.method === "GET" && pathname === "/drizzle-health") {
          const rows = (yield* db.execute(sql`select 1 as one`)) as unknown as {
            one: number;
          }[];
          return yield* HttpServerResponse.json({ rows });
        }

        // Cross-path consistency: rows written via the Data API fixture are
        // visible over the wire-protocol connection.
        if (request.method === "GET" && pathname === "/drizzle-todos") {
          const rows = (yield* db.execute(
            sql`select count(*)::int as count from todos`,
          )) as unknown as { count: number }[];
          return yield* HttpServerResponse.json({ rows });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(RDS.ConnectHttp)),
);
