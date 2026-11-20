import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { CappedContainerObject, RemoteContainerObject } from "./object.ts";

// Report failures in the response body, so a test that times out waiting
// for the container shows why instead of a bare 500.
const reportFailure = Effect.catchCause((cause: Cause.Cause<unknown>) =>
  Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
);

export default class RemoteContainerWorker extends Cloudflare.Worker<RemoteContainerWorker>()(
  "RemoteContainerWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* RemoteContainerObject;
    const capped = yield* CappedContainerObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/hello") {
          const text = yield* objects.getByName("default").hello();
          return HttpServerResponse.text(text);
        }

        if (url.pathname === "/capped") {
          const name = url.searchParams.get("name") ?? "default";
          return yield* HttpServerResponse.json(yield* capped.getByName(name).start());
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
        reportFailure,
      ),
    };
  }),
) {}
