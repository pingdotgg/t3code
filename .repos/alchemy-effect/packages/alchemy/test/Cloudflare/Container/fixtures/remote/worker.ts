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
