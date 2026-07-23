import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class InternalWorker extends Cloudflare.Worker<InternalWorker>()(
  "InternalWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("Hello from InternalWorker", {
          status: 200,
        });
      }),
    };
  }),
) {}
