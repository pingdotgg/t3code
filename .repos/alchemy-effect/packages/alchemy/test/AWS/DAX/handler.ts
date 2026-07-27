import * as DAX from "@/AWS/DAX";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Well-formed-but-nonexistent cluster name — the /clusters route drives the
// DescribeClusters binding against it so the fixture exercises the IAM grant
// and the typed error decode at zero cost (no cluster is ever created).
const NONEXISTENT_CLUSTER_NAME = "alchemy-nonexistent-dax-probe";

export class DAXTestFunction extends Lambda.Function<Lambda.Function>()(
  "DAXTestFunction",
) {}

export default DAXTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const describeClusters = yield* DAX.DescribeClusters();
    const describeEvents = yield* DAX.DescribeEvents();

    const bound = {
      describeClusters,
      describeEvents,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/clusters") {
          // A nonexistent cluster name must surface the service's typed
          // not-found tag — an IAM gap would surface AccessDeniedException
          // and fail the route with an opaque 500 instead.
          const tag = yield* describeClusters({
            ClusterNames: [NONEXISTENT_CLUSTER_NAME],
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ClusterNotFoundFault", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/events") {
          // Listing the account's recent DAX events succeeds (possibly
          // empty) — proves the grant and the response schema decode.
          const result = yield* describeEvents();
          return yield* HttpServerResponse.json({
            count: (result.Events ?? []).length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(DAX.DescribeClustersHttp, DAX.DescribeEventsHttp),
    ),
  ),
);
