import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { produceRoute, SourceQueue } from "./queue-sink-shared.ts";

/**
 * Producer-only Worker that drains clicks into the shared source queue
 * through `QueueSinkHttp` (bulk-push HTTP API with a scoped token). The
 * `QueueSinkWorker` consumers carry them the rest of the way. Live-only:
 * the HTTP layer mints a real account API token.
 */
export default class QueueSinkHttpWorker extends Cloudflare.Worker<QueueSinkHttpWorker>()(
  "QueueSinkHttpWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const source = yield* SourceQueue;
    const clicks = yield* Cloudflare.Queues.QueueSink(source);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (request.method === "POST" && url.pathname === "/produce") {
          return yield* produceRoute(clicks, url);
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Queues.QueueSinkHttp)),
) {}
