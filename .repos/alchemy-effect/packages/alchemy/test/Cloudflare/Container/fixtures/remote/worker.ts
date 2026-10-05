import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RemoteContainerObject } from "./object.ts";

export default class RemoteContainerWorker extends Cloudflare.Worker<RemoteContainerWorker>()(
  "RemoteContainerWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* RemoteContainerObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/hello") {
          const text = yield* objects.getByName("default").hello();
          return HttpServerResponse.text(text);
        }

        if (url.pathname.startsWith("/passthrough")) {
          // Forward the raw incoming request through the DO's fetch handler
          // to the container port (see the fixture object's `fetch`).
          return yield* objects.getByName("default").fetch(request);
        }

        return HttpServerResponse.text("ok");
      }).pipe(
        Effect.catchTag("HttpClientError", (err) =>
          Effect.succeed(
            err.response
              ? HttpServerResponse.fromClientResponse(err.response)
              : HttpServerResponse.text(err.message, {
                  status: 500,
                }),
          ),
        ),
      ),
    };
  }),
) {}
