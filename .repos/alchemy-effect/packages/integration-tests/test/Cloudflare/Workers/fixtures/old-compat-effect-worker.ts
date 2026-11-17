import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Effect-native Worker on a compatibility date whose `process` has no
 * `stdin`: the runtime's platform services must not touch it at startup.
 */
export default class OldCompatEffectWorker extends Cloudflare.Worker<OldCompatEffectWorker>()(
  "OldCompatEffectWorker",
  {
    main: import.meta.url,
    compatibility: { date: "2025-01-01" },
  },
  Effect.succeed({
    fetch: Effect.succeed(HttpServerResponse.text("Hello from an old compatibility date")),
  }),
) {}
