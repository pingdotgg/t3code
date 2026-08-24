import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";

/**
 * Effect-native Worker fixture for the Worker Loader binding. Yielding
 * `Cloudflare.WorkerLoader(name)` during Init registers the
 * `worker_loader` binding on this Worker and returns the runtime handle in one
 * step — no separate `.bind(...)`. The fetch handler loads an isolated dynamic
 * Worker from inline source and proxies the request to it over Effect-native
 * HTTP.
 */
export default class DynamicLoaderEffectWorker extends Cloudflare.Worker<DynamicLoaderEffectWorker>()(
  "DynamicLoaderEffectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const loader = yield* Cloudflare.WorkerLoader("LOADER");

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        // Probe routes: the dynamic worker attempts an outbound fetch and
        // reports whether the runtime allowed it. `/outbound/sandboxed` loads
        // it with `globalOutbound: null` (network access must be blocked);
        // `/outbound/open` omits it (default outbound must work).
        if (request.url.startsWith("/outbound/")) {
          const worker = yield* loader.load({
            compatibilityDate: "2026-01-28",
            mainModule: "worker.js",
            modules: {
              "worker.js": `export default {
                async fetch() {
                  try {
                    const res = await fetch("https://example.com/");
                    return Response.json({ outbound: "allowed", status: res.status });
                  } catch (error) {
                    return Response.json({ outbound: "blocked", error: String(error) });
                  }
                }
              }`,
            },
            ...(request.url.startsWith("/outbound/sandboxed")
              ? { globalOutbound: null }
              : {}),
          });
          return yield* worker.fetch(request).pipe(Effect.orDie);
        }

        const worker = yield* loader.load({
          compatibilityDate: "2026-01-28",
          mainModule: "worker.js",
          modules: {
            "worker.js": `export default {
              async fetch() {
                return Response.json({ mode: "effect", ok: true });
              }
            }`,
          },
        });

        return yield* worker.fetch(request).pipe(Effect.orDie);
      }),
    };
  }),
) {}
