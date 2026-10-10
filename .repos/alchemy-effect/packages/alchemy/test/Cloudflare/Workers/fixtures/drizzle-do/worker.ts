import * as Cloudflare from "@/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { DrizzleClockObject, DrizzleUsersObject } from "./object.ts";

export default class DrizzleDurableObjectWorker extends Cloudflare.Worker<DrizzleDurableObjectWorker>()(
  "DrizzleDurableObjectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const clocks = yield* DrizzleClockObject;
    const objects = yield* DrizzleUsersObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const object = objects.getByName(
          url.searchParams.get("do") ?? "default",
        );

        if (url.pathname === "/sqlite-clock") {
          return yield* Effect.gen(function* () {
            if (url.searchParams.get("direct") === "true") {
              const name = yield* object.clockName();
              yield* clocks.getByName(name).wait();
            } else {
              yield* object.sqliteClock();
            }
            return yield* HttpServerResponse.json({ clock: "ready" });
          }).pipe(
            Effect.catchCause((cause) =>
              HttpServerResponse.json(
                { error: Cause.pretty(cause) },
                { status: 500 },
              ),
            ),
          );
        }

        if (url.pathname === "/sqlite-gate") {
          return yield* object
            .sqliteGate(url.searchParams.get("view") === "true")
            .pipe(
              Effect.flatMap((result) => HttpServerResponse.json(result)),
              Effect.catchCause((cause) =>
                HttpServerResponse.json(
                  { error: Cause.pretty(cause) },
                  { status: 500 },
                ),
              ),
            );
        }

        if (url.pathname === "/sqlite-rollback") {
          const result = yield* object.sqliteRollback().pipe(Effect.orDie);
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && url.pathname === "/users") {
          const name = url.searchParams.get("name") ?? "anonymous";
          const id = yield* object.addUser(name).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true, id });
        }

        if (request.method === "POST" && url.pathname === "/posts") {
          const userId = Number(url.searchParams.get("user"));
          const title = url.searchParams.get("title") ?? "untitled";
          yield* object.addPost(userId, title).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && url.pathname === "/users") {
          const names = yield* object.listUsers().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ names });
        }

        if (request.method === "GET" && url.pathname === "/users-with-posts") {
          const rows = yield* object.listUsersWithPosts().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ users: rows });
        }

        if (request.method === "GET" && url.pathname === "/missing-table") {
          const result = yield* object.queryMissingTable().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ result });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}
