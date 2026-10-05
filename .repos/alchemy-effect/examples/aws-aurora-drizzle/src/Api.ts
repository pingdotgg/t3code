import * as AWS from "alchemy/AWS";
import * as Drizzle from "alchemy/Drizzle/Postgres";
import * as Duration from "effect/Duration";
import { eq, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { bootstrap } from "./bootstrap.ts";
import { database } from "./database.ts";
import { todos } from "./schema.ts";

export default class Api extends AWS.Lambda.Function<Api>()(
  "Api",
  Effect.gen(function* () {
    const schemaVersion = yield* bootstrap;
    return {
      main: import.meta.url,
      runtime: "nodejs22.x" as const,
      functionUrl: { authType: "AWS_IAM" as const },
      timeout: Duration.seconds(30),
      build: { install: ["pg"] },
      env: {
        SCHEMA_VERSION: schemaVersion,
        NODE_EXTRA_CA_CERTS: "/var/runtime/ca-cert.pem",
      },
    };
  }),
  Effect.gen(function* () {
    const { cluster, subnetIds, lambdaSecurityGroup } = yield* database;
    const connect = yield* AWS.RDS.Connect(cluster, {
      auth: "iam",
      username: "app_iam",
      database: "app",
      subnetIds,
      securityGroupIds: [lambdaSecurityGroup.groupId],
    });
    const db = yield* Drizzle.Postgres(
      connect.pipe(
        Effect.map((connection) => {
          const url = new URL(Redacted.value(connection.url));
          // Connect currently emits no-verify; require full certificate verification.
          url.searchParams.set("sslmode", "verify-full");
          return Redacted.make(url.toString());
        }),
      ),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        if (request.method === "GET" && url.pathname === "/health") {
          const rows = yield* db.execute(sql`SELECT current_user AS username,
            (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
            has_table_privilege(current_user, 'todos', 'INSERT') AS can_insert,
            has_schema_privilege(current_user, 'public', 'CREATE') AS can_create`);
          return yield* HttpServerResponse.json(rows);
        }
        if (url.pathname === "/todos" && request.method === "GET") {
          return yield* HttpServerResponse.json(yield* db.select().from(todos));
        }
        if (url.pathname === "/todos" && request.method === "POST") {
          const input = yield* request.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  id: Schema.String.check(Schema.isUUID()),
                  title: Schema.NonEmptyString,
                }),
              ),
            ),
          );
          return yield* HttpServerResponse.json(
            yield* db.insert(todos).values(input).returning(),
            { status: 201 },
          );
        }
        if (url.pathname.startsWith("/todos/")) {
          const id = yield* Schema.decodeUnknownEffect(
            Schema.String.check(Schema.isUUID()),
          )(url.pathname.slice(7));
          if (request.method === "PATCH") {
            const input = yield* request.json.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({ done: Schema.Boolean }),
                ),
              ),
            );
            return yield* HttpServerResponse.json(
              yield* db
                .update(todos)
                .set(input)
                .where(eq(todos.id, id))
                .returning(),
            );
          }
          if (request.method === "DELETE") {
            yield* db.delete(todos).where(eq(todos.id, id));
            return HttpServerResponse.empty({ status: 204 });
          }
        }
        return HttpServerResponse.text("Not found", { status: 404 });
      }).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.succeed(
            HttpServerResponse.text("Invalid request", { status: 400 }),
          ),
        ),
        Effect.orDie,
      ),
    };
  }).pipe(Effect.provide(AWS.RDS.ConnectHttp)),
) {}
