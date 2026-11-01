import * as GCP from "alchemy/GCP";
import * as Drizzle from "alchemy/Drizzle/Postgres";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { database } from "./database.ts";
import { migrate } from "./migrate.ts";
import { todos } from "./schema.ts";

const Id = Schema.String.check(Schema.isUUID());

/**
 * A todo API on Cloud Run backed by Cloud SQL for PostgreSQL.
 *
 * `GCP.SQL.Connect` mounts the instance's Unix socket into the revision
 * and grants the runtime service account `roles/cloudsql.client` on this
 * instance only; Drizzle then talks Postgres over
 * `/cloudsql/{connectionName}`.
 */
export default class Api extends GCP.Function<Api>()(
  "Api",
  Effect.gen(function* () {
    // Depending on the migration output makes the service deploy after
    // the schema exists, and roll a new revision when it changes.
    const schemaVersion = yield* migrate;
    return {
      main: import.meta.url,
      invokerIamDisabled: true,
      env: { SCHEMA_VERSION: schemaVersion },
    };
  }),
  Effect.gen(function* () {
    const { instance, db: appDb, user, passwordSecret } = yield* database;
    const connect = yield* GCP.SQL.Connect(instance, {
      database: appDb,
      user,
      passwordSecret,
    });
    const db = yield* Drizzle.Postgres(
      connect.pipe(Effect.map((info) => info.url)),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl, "http://localhost");

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }
        if (url.pathname === "/todos" && request.method === "GET") {
          return yield* HttpServerResponse.json(
            yield* db.select().from(todos).orderBy(todos.title),
          );
        }
        if (url.pathname === "/todos" && request.method === "POST") {
          const input = yield* request.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ id: Id, title: Schema.NonEmptyString }),
              ),
            ),
          );
          return yield* HttpServerResponse.json(
            yield* db.insert(todos).values(input).returning(),
            { status: 201 },
          );
        }
        if (url.pathname.startsWith("/todos/")) {
          const id = yield* Schema.decodeUnknownEffect(Id)(
            url.pathname.slice("/todos/".length),
          );
          if (request.method === "GET") {
            const [todo] = yield* db
              .select()
              .from(todos)
              .where(eq(todos.id, id));
            return todo
              ? yield* HttpServerResponse.json(todo)
              : HttpServerResponse.text("Not found", { status: 404 });
          }
          if (request.method === "PATCH") {
            const input = yield* request.json.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({ done: Schema.Boolean }),
                ),
              ),
            );
            const [todo] = yield* db
              .update(todos)
              .set(input)
              .where(eq(todos.id, id))
              .returning();
            return todo
              ? yield* HttpServerResponse.json(todo)
              : HttpServerResponse.text("Not found", { status: 404 });
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
  }).pipe(Effect.provide(GCP.SQL.ConnectHttp)),
) {}
