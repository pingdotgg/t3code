import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { EventsStream } from "./stream.ts";

/**
 * Effect-native Worker fixture for the Pipelines stream binding, going
 * through the `WriteStream` capability: the binding is registered by
 * `yield* Cloudflare.Pipelines.WriteStream(EventsStream)` and the client
 * exposes `send` as an Effect — no `env` declaration, no `Effect.promise`.
 */
export default class PipelinesEffectWorker extends Cloudflare.Worker<PipelinesEffectWorker>()(
  "PipelinesEffectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const events = yield* Cloudflare.Pipelines.WriteStream(EventsStream);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl, "http://x");
        // `send` only exists on a real `pipelines` binding — a `json`
        // binding would deliver the stream's attributes instead.
        const kind = typeof (yield* events.raw)?.send;
        if (url.pathname === "/send") {
          yield* events
            .send([
              {
                source: "pipelines-binding-test",
                nonce: url.searchParams.get("nonce") ?? "none",
              },
            ])
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            mode: "effect",
            sent: true,
            kind,
          });
        }
        return yield* HttpServerResponse.json({
          mode: "effect",
          sent: false,
          kind,
        });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Pipelines.WriteStreamBinding)),
) {}
