import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as EffectStream from "effect/Stream";
import { PageView, PageViews } from "./pipelines-stream.ts";

/**
 * Worker sending through the stream's HTTP ingest endpoint with a scoped
 * `Pipelines Send` token (`WriteStreamHttp` / `StreamSinkHttp`).
 */
export default class PipelinesHttpWorker extends Cloudflare.Worker<PipelinesHttpWorker>()(
  "PipelinesHttpWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const views = yield* Cloudflare.Basin.WriteStream(PageViews);
    const sink = yield* Cloudflare.Basin.StreamSink(PageViews);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl, "http://x");
        if (url.pathname === "/send") {
          yield* views
            .send([new PageView({ url: "/http", at: new Date(), tags: [] })])
            .pipe(Effect.orDie);
          yield* EffectStream.range(1, 20).pipe(
            EffectStream.map((i) => new PageView({ url: `/http/${i}`, at: new Date(), tags: [] })),
            EffectStream.run(sink),
            Effect.orDie,
          );
          return yield* HttpServerResponse.json({ sent: 21 });
        }
        return yield* HttpServerResponse.json({ ok: true });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.Basin.WriteStreamHttp, Cloudflare.Basin.StreamSinkHttp),
    ),
  ),
) {}
