import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// The hello-world Worker from #2371, importing the public barrel.
export default class BarrelWorker extends Cloudflare.Worker<BarrelWorker>()(
  "BarrelWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }),
) {}
