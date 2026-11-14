import { bindService } from "@alchemy.run/railway/Bind";
import { Function } from "@alchemy.run/railway/Function";
import { enableRailwayRpc } from "@alchemy.run/railway/rpc-server";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Api } from "./rpc-api-tag.ts";
import { Partition, Site } from "./rpc-shared.ts";

/**
 * Tagged Function that hosts `greet` and binds the tagged {@link Api}
 * Service. `GET /` is local so the public probe does not deadlock on
 * private-mesh RPC; `GET /pong` calls `api.ping()`.
 */
export default class Query extends Function<Query>()(
  "Query",
  { project: Site, environment: Partition, main: import.meta.url },
  Effect.gen(function* () {
    enableRailwayRpc();
    const api = yield* bindService(Api);
    return {
      greet: (name: string) => Effect.succeed(`hello ${name}`),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.includes("/pong")) {
          return HttpServerResponse.text(yield* api.ping());
        }
        return HttpServerResponse.text("query");
      }),
    };
  }),
) {}
