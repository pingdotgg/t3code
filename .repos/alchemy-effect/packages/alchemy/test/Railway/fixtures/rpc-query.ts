import { bindService } from "@/Railway/Bind.ts";
import { Function } from "@/Railway/Function.ts";
import { enableRailwayRpc } from "@/Railway/rpc-server.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
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
