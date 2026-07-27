import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { LocalRemoteContainerObject } from "./local-object.ts";

/**
 * Local-dev twin of `worker.ts` with its own logical id — see
 * `local-object.ts` for why the local suite owns a separate fixture identity.
 */
export default class LocalRemoteContainerWorker extends Cloudflare.Worker<LocalRemoteContainerWorker>()(
  "LocalRemoteContainerWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* LocalRemoteContainerObject;

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
