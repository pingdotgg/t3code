import * as AWS from "alchemy/AWS";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Database, DatabaseAurora } from "./Database.ts";
import { NetworkLive } from "./Network.ts";

export default class ServiceFunction extends AWS.Lambda.Function<ServiceFunction>()(
  "ServiceFunction",
  Stack.useSync((stack) => ({
    main: import.meta.filename,
    memory: stack.stage === "prod" ? 1024 : 512,
    runtime: "nodejs24.x",
  })),
  Effect.gen(function* () {
    const db = yield* Database;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (
          request.method === "GET" &&
          new URL(request.originalUrl).pathname === "/"
        ) {
          const response = yield* db
            .query<{
              database: string;
              current_time: string;
              current_user: string;
            }>(
              "select current_database() as database, now()::text as current_time, current_user::text as current_user",
            )
            .pipe(
              Effect.match({
                onFailure: (error) => ({
                  status: 500 as const,
                  body: {
                    ok: false,
                    error: error.message,
                  },
                }),
                onSuccess: (rows) => ({
                  status: 200 as const,
                  body: {
                    ok: true,
                    connection: rows[0] ?? null,
                  },
                }),
              }),
            );

          return yield* HttpServerResponse.json(response.body, {
            status: response.status,
          });
        }

        return HttpServerResponse.text("Not found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(DatabaseAurora),
        Layer.mergeAll(NetworkLive, AWS.RDS.ConnectLive),
      ),
    ),
  ),
) {}
