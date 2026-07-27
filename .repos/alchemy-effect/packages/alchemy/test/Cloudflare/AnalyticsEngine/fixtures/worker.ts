import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Dataset } from "./dataset.ts";

export default class AnalyticsEngineTestWorker extends Cloudflare.Worker<AnalyticsEngineTestWorker>()(
  "AnalyticsEngineTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const analytics = yield* Cloudflare.AnalyticsEngine.WriteDataset(Dataset);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/write") {
          yield* analytics
            .writeDataPoint({
              indexes: ["account-1"],
              blobs: ["signup"],
              doubles: [1],
            })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true });
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.AnalyticsEngine.WriteDatasetBinding)),
) {}
