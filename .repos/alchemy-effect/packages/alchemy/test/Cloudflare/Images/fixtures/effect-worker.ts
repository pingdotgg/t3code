import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native Worker fixture for the Cloudflare Images binding. Yielding
 * `Cloudflare.Images(...)` during Init attaches the binding to this Worker and
 * returns the runtime client in one step — no separate `.bind(...)`. The
 * worker forwards the request body (typed as `Stream.Stream<Uint8Array>`)
 * straight into `images.info(...)`, proving the Effect-native client converts
 * an Effect Stream into the runtime ReadableStream the binding expects.
 */
export default class ImagesEffectWorker extends Cloudflare.Worker<ImagesEffectWorker>()(
  "ImagesEffectWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const images = yield* Cloudflare.Images({ name: "PIPELINE" });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const info = yield* images.info(request.stream).pipe(Effect.orDie);
        return yield* HttpServerResponse.json({ mode: "effect", ...info });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.ImagesBindingLive)),
) {}
