import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Worker fixture for the `Worker.URL` binding: yielding it
 * attaches the binding and returns a deferred accessor; the handler reads
 * the URL string and echoes it back.
 */
export default class UrlEffectWorker extends Cloudflare.Worker<UrlEffectWorker>()(
  "UrlEffectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const url = yield* Cloudflare.Worker.URL;
    return {
      fetch: Effect.gen(function* () {
        const publicUrl = yield* url;
        return yield* HttpServerResponse.json({ url: publicUrl });
      }),
    };
  }),
) {}
