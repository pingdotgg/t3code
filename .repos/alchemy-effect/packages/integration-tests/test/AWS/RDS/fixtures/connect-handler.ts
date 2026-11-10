import * as Lambda from "@alchemy.run/aws/Lambda";
import * as RDS from "@alchemy.run/aws/RDS";
import * as Drizzle from "@alchemy.run/drizzle/Postgres";
import { sql } from "drizzle-orm";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import path from "pathe";
import { RdsConnectInfra } from "./connect-infra.ts";

const main = path.resolve(import.meta.dirname, "connect-handler.ts");

export class RdsConnectFunction extends Lambda.Function<Lambda.Function>()("RdsConnectFunction") {}

/**
 * `RDS.Connect` bound to a standalone `DBInstance`, both ways:
 *
 * - no `secret` — reads the instance's RDS-managed master user secret
 *   (through the Secrets Manager interface endpoint) and connects as the
 *   master user.
 * - `auth: "iam"` — grants `rds-db:connect` on the instance's
 *   `dbuser:{DbiResourceId}/app_iam` and presigns a token as the password.
 */
export default RdsConnectFunction.make(
  {
    main,
    functionUrl: true,
    // First query per execution builds the pool + TLS handshake.
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const { network, lambdaSecurityGroup, instance } = yield* RdsConnectInfra;
    const vpc = {
      subnetIds: network.privateSubnetIds,
      securityGroupIds: [lambdaSecurityGroup.groupId],
    };

    const connect = yield* RDS.Connect(instance, { database: "postgres", ...vpc });
    const connectIam = yield* RDS.Connect(instance, {
      auth: "iam",
      username: "app_iam",
      database: "postgres",
      ...vpc,
    });

    const db = yield* Drizzle.Postgres(Effect.map(connect, (info) => info.url));
    const iamDb = yield* Drizzle.Postgres(Effect.map(connectIam, (info) => info.url));

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Connection settings from the managed secret. The password is
        // never echoed — only its presence.
        if (request.method === "GET" && pathname === "/connect-info") {
          const info = yield* connect;
          return yield* HttpServerResponse.json({
            host: info.host,
            port: info.port,
            database: info.database,
            username: info.username,
            hasPassword: typeof info.password === "string" && info.password.length > 0,
            ssl: info.ssl,
          });
        }

        // Socket round-trip as the master user, which also bootstraps the
        // IAM-auth database user (idempotent).
        if (request.method === "POST" && pathname === "/setup-iam-user") {
          yield* db.execute(
            sql`DO $$ BEGIN CREATE USER app_iam WITH LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
          );
          yield* db.execute(sql`GRANT rds_iam TO app_iam`);
          const rows = yield* db.execute<{ user: string }>(
            sql`select current_user as "user"`,
            "objects",
          );
          return yield* HttpServerResponse.json({ rows });
        }

        // Socket round-trip authenticated with a presigned IAM token.
        if (request.method === "GET" && pathname === "/iam-user") {
          const rows = yield* iamDb.execute<{ user: string }>(
            sql`select current_user as "user"`,
            "objects",
          );
          return yield* HttpServerResponse.json({ rows });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        // Surface the cause so a failing request explains itself in the test.
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(RDS.ConnectHttp)),
);
