import * as AWS from "alchemy/AWS";
import { eq, sql } from "drizzle-orm";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { connectDatabase } from "./client.ts";
import { Todos } from "./schema.ts";

export default class Api extends AWS.Lambda.Function<Api>()(
  "Api",
  {
    main: import.meta.url,
    runtime: "nodejs22.x",
    functionUrl: { authType: "AWS_IAM" },
    timeout: Duration.seconds(30),
    build: { install: ["pg"] },
  },
  Effect.gen(function* () {
    const db = yield* connectDatabase;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        if (request.method === "GET" && url.pathname === "/health") {
          const result = yield* db.execute(
            sql`SELECT current_user AS username`,
          );
          return yield* HttpServerResponse.json(result);
        }
        if (url.pathname === "/todos" && request.method === "GET") {
          return yield* HttpServerResponse.json(yield* db.select().from(Todos));
        }
        if (url.pathname === "/todos" && request.method === "POST") {
          const input = yield* request.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  id: Schema.String.check(Schema.isUUID()),
                  text: Schema.NonEmptyString,
                }),
              ),
            ),
          );
          return yield* HttpServerResponse.json(
            yield* db.insert(Todos).values(input).returning(),
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
                .update(Todos)
                .set(input)
                .where(eq(Todos.id, id))
                .returning(),
            );
          }
          if (request.method === "DELETE") {
            yield* db.delete(Todos).where(eq(Todos.id, id));
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
  }).pipe(Effect.provide(AWS.DSQL.ConnectHttp)),
) {}
