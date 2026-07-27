import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * A service whose Layer performs real async I/O during the isolate build —
 * the "fetch a value once and cache it for every request" pattern. The
 * fetched text and an init-time nonce are plain values: retaining them
 * across events is legal on workerd (unlike I/O-backed objects, which are
 * pinned to the creating request's IoContext).
 */
class TraceConfig extends Context.Service<
  TraceConfig,
  { trace: string; nonce: string }
>()("InitIO.TraceConfig") {}

const TraceConfigLive = Layer.effect(
  TraceConfig,
  Effect.gen(function* () {
    // Counted per isolate so every response can assert the layer's I/O ran
    // exactly once no matter how many events the isolate has served.
    yield* Effect.sync(() => {
      (globalThis as any).__initFetches =
        ((globalThis as any).__initFetches ?? 0) + 1;
    });
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(
      "https://www.cloudflare.com/cdn-cgi/trace",
    );
    const trace = yield* response.text;
    return {
      trace,
      // Regenerated only when the layer rebuilds — every event served by
      // this isolate must observe the same value.
      nonce: crypto.randomUUID(),
    };
  }).pipe(
    // A failed init fetch is a defect: the isolate is useless without its
    // config, and init's typed error channel is reserved for ConfigError.
    Effect.orDie,
  ),
);

/**
 * Pins that one-shot async I/O during init / layer build works under the
 * build-once bridge: the layer's fetch runs exactly once per isolate (the
 * first event's context awaits it; concurrent cold-start events share the
 * same in-flight build), and the cached plain value serves every request.
 */
export default class InitIOWorker extends Cloudflare.Worker<InitIOWorker>()(
  "InitIOWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const config = yield* TraceConfig;

    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({
          nonce: config.nonce,
          traceLength: config.trace.length,
          hasUag: config.trace.includes("uag="),
          initFetches: (globalThis as any).__initFetches ?? 0,
        });
      }),
    };
  }).pipe(Effect.provide(TraceConfigLive)),
) {}
