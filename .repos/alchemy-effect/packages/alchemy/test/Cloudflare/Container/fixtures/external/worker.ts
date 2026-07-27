import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ExternalContainerObject } from "./object.ts";

export default class ExternalContainerWorker extends Cloudflare.Worker<ExternalContainerWorker>()(
  "ExternalContainerWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* ExternalContainerObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/hello") {
          const text = yield* objects
            .getByName("default")
            .hello()
            .pipe(Effect.orDie);
          return HttpServerResponse.text(text);
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
