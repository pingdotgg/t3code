import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { InterceptContainerObject } from "./object.ts";

export default class InterceptContainerWorker extends Cloudflare.Worker<InterceptContainerWorker>()(
  "InterceptContainerWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* InterceptContainerObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        // One object, and so one container, per interception mode.
        if (url.pathname === "/probe/host") {
          return HttpServerResponse.text(yield* objects.getByName("host").probeHost());
        }
        if (url.pathname === "/probe/all") {
          return HttpServerResponse.text(yield* objects.getByName("all").probeAll());
        }
        return HttpServerResponse.text("ok");
      }).pipe(
        Effect.catchTag("HttpClientError", (err) =>
          Effect.succeed(
            err.response
              ? HttpServerResponse.fromClientResponse(err.response)
              : HttpServerResponse.text(err.message, { status: 500 }),
          ),
        ),
      ),
    };
  }),
) {}
