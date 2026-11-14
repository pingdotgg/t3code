import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// Async bindings route through WorkerAsyncBindings, which imports the `is*`
// guards from the resource modules that also hold the providers (#2371).
export default class BindingsWorker extends Cloudflare.Worker<BindingsWorker>()(
  "BindingsWorker",
  {
    main: import.meta.url,
    env: {
      KV: Cloudflare.KV.Namespace("RuntimeEntryKV"),
      QUEUE: Cloudflare.Queues.Queue("RuntimeEntryQueue"),
    },
  },
  Effect.gen(function* () {
    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }),
) {}
