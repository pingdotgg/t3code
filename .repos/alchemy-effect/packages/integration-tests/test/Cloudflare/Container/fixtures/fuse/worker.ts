import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { FuseContainerObject } from "./object.ts";

export default class FuseContainerWorker extends Cloudflare.Worker<FuseContainerWorker>()(
  "FuseContainerWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* FuseContainerObject;

    return {
      fetch: Effect.gen(function* () {
        const text = yield* objects.getByName("default").read();
        return HttpServerResponse.text(text);
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
