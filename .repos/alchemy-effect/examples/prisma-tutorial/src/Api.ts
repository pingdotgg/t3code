import * as Prisma from "alchemy/Prisma";
import * as SQL from "alchemy/SQL/Postgres";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Connection, Project } from "./Database.ts";

export default class Api extends Prisma.Compute<Api>()(
  "Api",
  Effect.gen(function* () {
    const project = yield* Project;
    return {
      project,
      main: import.meta.filename,
      regionId: "eu-west-3",
      branchGitName: "main",
      port: 3000,
      healthCheck: { path: "/api/health" },
      destroyOldDeployment: true,
    };
  }),
  Effect.gen(function* () {
    const db = yield* Prisma.Connect(Connection);
    const sql = yield* SQL.Postgres({ url: db.databaseUrl });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const headers = { "access-control-allow-origin": "*" };
        if (request.method !== "GET") {
          return HttpServerResponse.text("Method not allowed", {
            status: 405,
            headers: { ...headers, allow: "GET" },
          });
        }
        if (request.url === "/api/health") {
          return yield* HttpServerResponse.json({ ok: true }, { headers });
        }
        if (request.url === "/api/time") {
          const rows = yield* sql<{
            time: string;
          }>`SELECT current_timestamp::text AS time`;
          return yield* HttpServerResponse.json(rows[0], { headers });
        }
        return HttpServerResponse.text("Not found", { status: 404, headers });
      }).pipe(
        Effect.catchTag("SqlError", () =>
          Effect.succeed(
            HttpServerResponse.text("Database unavailable", {
              status: 503,
              headers: { "access-control-allow-origin": "*" },
            }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Prisma.ConnectBinding)),
) {}
