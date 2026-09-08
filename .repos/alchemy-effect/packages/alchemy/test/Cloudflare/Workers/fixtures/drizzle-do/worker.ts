import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DrizzleUsersObject } from "./object.ts";

export default class DrizzleDurableObjectWorker extends Cloudflare.Worker<DrizzleDurableObjectWorker>()(
  "DrizzleDurableObjectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* DrizzleUsersObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const object = objects.getByName(
          url.searchParams.get("do") ?? "default",
        );

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
