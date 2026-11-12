import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as EffectStream from "effect/Stream";
import { PageView, PageViews } from "./pipelines-stream.ts";

/**
 * Effect-native Worker exercising the typed Pipelines producers over the
 * native `pipelines` binding: `/send` (WriteStream), `/sink` (StreamSink)
 * and `/invalid` (a record the stream's Effect Schema rejects).
 */
export default class PipelinesWorker extends Cloudflare.Worker<PipelinesWorker>()(
  "PipelinesWorker",
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
            .send([
              new PageView({ url: "/a", at: new Date(), tags: ["x"] }),
              new PageView({ url: "/b", at: new Date(), tags: [], user: { id: "u1" } }),
            ])
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ sent: 2 });
        }
        if (url.pathname === "/sink") {
          const count = Number(url.searchParams.get("count") ?? "300");
          yield* EffectStream.range(1, count).pipe(
            EffectStream.map((i) => new PageView({ url: `/p/${i}`, at: new Date(), tags: [] })),
            EffectStream.run(sink),
            Effect.orDie,
          );
          return yield* HttpServerResponse.json({ sent: count });
        }
        if (url.pathname === "/invalid") {
          const result = yield* views
            .send([{ url: "/c", at: "not-a-date", tags: [] } as unknown as PageView])
            .pipe(
              Effect.as({ reason: "none" as string, index: -1 }),
              Effect.catchTag("StreamSendError", (e) =>
                Effect.succeed({ reason: e.reason ?? "unknown", index: e.index ?? -1 }),
              ),
            );
          return yield* HttpServerResponse.json(result);
        }
        return yield* HttpServerResponse.json({ ok: true });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.Basin.WriteStreamBinding, Cloudflare.Basin.StreamSinkBinding),
    ),
  ),
) {}
