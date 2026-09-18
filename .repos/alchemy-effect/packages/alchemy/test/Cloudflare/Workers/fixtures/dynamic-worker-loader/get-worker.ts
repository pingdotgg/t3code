import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";

/**
 * Effect-native Worker whose fetch handler uses `loader.get()` — not
 * `load()` — then proxies through `worker.fetch()`. Native `get()` returns
 * a WorkerStub whose fetcher is `getEntrypoint()`; wrapping the stub as a
 * Fetcher made the first `worker.fetch(...)` throw
 * `TypeError: fetcher.fetch is not a function` (#1382).
 *
 * Isolate id is `?id=`; `?entrypoint=1` goes through `getEntrypoint().fetch()`
 * instead. The dynamic Worker keeps a module-scope hit counter so a second
 * request with the same id proves the isolate was reused.
 */
export default class DynamicLoaderGetWorker extends Cloudflare.Worker<DynamicLoaderGetWorker>()(
  "DynamicLoaderGetWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const loader = yield* Cloudflare.WorkerLoader("LOADER");

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const id = url.searchParams.get("id") ?? "default";
        const viaEntrypoint = url.searchParams.get("entrypoint") === "1";

        const worker = yield* loader.get(id, () => ({
          compatibilityDate: "2026-01-28",
          mainModule: "worker.js",
          modules: {
            "worker.js": `let hits = 0;
export default {
  async fetch() {
    hits += 1;
    return Response.json({ id: ${JSON.stringify(id)}, hits }, {
      headers: { "cache-control": "no-store" },
    });
  }
}`,
          },
        }));

        return yield* (
          viaEntrypoint
            ? worker.getEntrypoint().fetch(request)
            : worker.fetch(request)
        ).pipe(Effect.orDie);
      }),
    };
  }),
) {}
