import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { NeonHostContainerObject } from "./object.ts";

export default class NeonHostContainerWorker extends Cloudflare.Worker<NeonHostContainerWorker>()(
  "NeonHostContainerWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* NeonHostContainerObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const object = objects.getByName("default");

        if (url.pathname === "/env") {
          return HttpServerResponse.text(yield* object.getEnv());
        }
        if (url.pathname === "/probe") {
          return HttpServerResponse.text(yield* object.getProbe());
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
