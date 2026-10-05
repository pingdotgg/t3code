import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Users from "./Users.ts";

const CreateUser = Schema.Struct({ name: Schema.String });

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = request.url.split("?")[0];
        const match = /^\/objects\/([a-zA-Z0-9_-]+)\/users$/.exec(path);
        if (!match) {
          return yield* HttpServerResponse.json(
            { error: "Use /objects/:name/users (letters, digits, _ or -)" },
            { status: 404 },
          );
        }

        const object = users.getByName(match[1]);
        if (request.method === "GET") {
          const rows = yield* object.listUsers();
          return yield* HttpServerResponse.json({ users: rows });
        }
        if (request.method === "POST") {
          const body = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(CreateUser)),
            Effect.catch(() => Effect.succeed(undefined)),
          );
          if (!body?.name.trim()) {
            return yield* HttpServerResponse.json(
              { error: "Expected JSON with a non-empty name" },
              { status: 400 },
            );
          }
          const [user] = yield* object.addUser(body.name.trim());
          return yield* HttpServerResponse.json({ user }, { status: 201 });
        }
        return yield* HttpServerResponse.json(
          { error: "Method not allowed" },
          { status: 405, headers: { allow: "GET, POST" } },
        );
      }).pipe(
        Effect.catchTag("EffectDrizzleQueryError", () =>
          HttpServerResponse.json(
            { error: "Database query failed" },
            { status: 500 },
          ),
        ),
      ),
    };
  }),
) {}
