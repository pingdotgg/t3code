import * as AWS from "@/AWS/index.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * A service whose Layer performs real async I/O during the sandbox's init
 * (cold start) — the "fetch a value once and cache it for every
 * invocation" pattern.
 */
class TraceConfig extends Context.Service<
  TraceConfig,
  { trace: string; nonce: string }
>()("InitIO.TraceConfig") {}

const TraceConfigLive = Layer.effect(
  TraceConfig,
  Effect.gen(function* () {
    // Counted per sandbox so every response can assert the layer's I/O ran
    // exactly once no matter how many invocations the sandbox has served.
    yield* Effect.sync(() => {
      (globalThis as any).__initFetches =
        ((globalThis as any).__initFetches ?? 0) + 1;
    });
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(
      "https://www.cloudflare.com/cdn-cgi/trace",
    );
    const trace = yield* response.text;
    return { trace, nonce: crypto.randomUUID() };
  }).pipe(
    // A failed init fetch is a defect: the sandbox is useless without its
    // config, and init's typed error channel is reserved for ConfigError.
    Effect.orDie,
  ),
);

/**
 * Pins that one-shot async I/O during init / layer build works on Lambda:
 * the layer's fetch runs exactly once per sandbox (at cold start, under the
 * instance scope) and the cached plain value serves every invocation.
 */
export default class InitIOProbe extends AWS.Lambda.Function<InitIOProbe>()(
  "InitIOProbe",
  {
    main: import.meta.url,
    url: true,
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
