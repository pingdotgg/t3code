import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ReloadContainerObject } from "./object.ts";

/** `GET /<file>` proxies to the container's httpd via the DO. */
export default class ReloadContainerWorker extends Cloudflare.Worker<ReloadContainerWorker>()(
  "ReloadContainerWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* ReloadContainerObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const text = yield* objects
          .getByName("default")
          .read(url.pathname)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.succeed(`CONTAINER_UNREACHABLE: ${cause}`),
            ),
          );
        return HttpServerResponse.text(text);
      }),
    };
  }),
) {}
