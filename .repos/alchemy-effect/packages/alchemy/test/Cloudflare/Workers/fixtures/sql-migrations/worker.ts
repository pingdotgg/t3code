import * as Cloudflare from "@/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  CustomMigratedObject,
  MigratedObject,
  MigrationScenarios,
} from "./object.ts";

export default class SqlMigrationsWorker extends Cloudflare.Worker<SqlMigrationsWorker>()(
  "SqlMigrationsWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* MigratedObject;
    const customObjects = yield* CustomMigratedObject;
    const scenarios = yield* MigrationScenarios;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://fixture");
        const name = url.searchParams.get("name") ?? "default";
        const route = `${request.method} ${url.pathname}`;

        if (route === "GET /health") {
          return HttpServerResponse.text("sql-migrations:ready");
        }
        if (route === "GET /state") {
          return yield* HttpServerResponse.json(
            yield* objects.getByName(name).inspect().pipe(Effect.orDie),
          );
        }
        if (route === "POST /users") {
          yield* objects
            .getByName(name)
            .addUser(url.searchParams.get("user") ?? "added")
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true });
        }
        if (route === "POST /repeat") {
          return yield* HttpServerResponse.json(
            yield* objects.getByName(name).repeat().pipe(Effect.orDie),
          );
        }
        if (route === "POST /reset") {
          const reset = yield* objects
            .getByName(name)
            .reset()
            .pipe(
              Effect.matchCause({
                onFailure: () => true,
                onSuccess: () => false,
              }),
            );
          return yield* HttpServerResponse.json({ reset });
        }
        if (route === "GET /custom") {
          return yield* HttpServerResponse.json(
            yield* customObjects.getByName(name).inspect().pipe(Effect.orDie),
          );
        }
        if (route === "POST /custom/repeat") {
          return yield* HttpServerResponse.json(
            yield* customObjects.getByName(name).repeat().pipe(Effect.orDie),
          );
        }
        if (route === "POST /rollback") {
          return yield* HttpServerResponse.json(
            yield* scenarios.getByName(name).rollback().pipe(Effect.orDie),
          );
        }
        if (route === "POST /adopt") {
          return yield* HttpServerResponse.json(
            yield* scenarios.getByName(name).adopt().pipe(Effect.orDie),
          );
        }
        if (route === "POST /conflict") {
          return yield* HttpServerResponse.json(
            yield* scenarios
              .getByName(name)
              .conflict(url.searchParams.has("empty"))
              .pipe(Effect.orDie),
          );
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(Cause.pretty(cause), { status: 500 }),
          ),
        ),
      ),
    };
  }),
) {}
