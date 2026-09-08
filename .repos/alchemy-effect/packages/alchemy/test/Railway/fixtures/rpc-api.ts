import { bindFunction } from "@/Railway/Bind.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Api } from "./rpc-api-tag.ts";
import Query from "./rpc-query.ts";
import { Partition, Site } from "./rpc-shared.ts";

export { Api };

/**
 * Tagged Service that hosts `ping` and binds the tagged {@link Query}
 * Function. `GET /` is local; `GET /hello` calls `query.greet("sam")`.
 *
 * Default-export the `.make()` Layer: the Docker bootstrap loads
 * `default`, and a Tag class never registers `fetch`/`run`.
 */
export const ApiLive = Api.make(
  {
    project: Site,
    environment: Partition,
    main: import.meta.url,
    port: 3000,
  },
  Effect.gen(function* () {
    const query = yield* bindFunction(Query);
    return {
      ping: () => Effect.succeed("pong"),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.includes("/hello")) {
          return HttpServerResponse.text(yield* query.greet("sam"));
        }
        return HttpServerResponse.text("api");
      }),
    };
  }),
);

export default ApiLive;
