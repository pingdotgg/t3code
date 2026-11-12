import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { BunContainer } from "./bun-container.ts";

/**
 * Durable Object backing one bun-baseline container instance. `boot()` blocks
 * until the `Bun.serve` HTTP server answers on its TCP port. NOTE: the
 * authoritative cold-start clock runs in the Worker AROUND the whole DO call,
 * so it also covers Durable Object construction.
 */
export class BunObject extends Cloudflare.DurableObject<BunObject>()(
  "BenchBunObject",
  Effect.gen(function* () {
    const container = yield* BunContainer;

    return Effect.gen(function* () {
      const port = yield* container.getTcpPort(8080);

      return {
        boot: () =>
          Effect.gen(function* () {
            const start = yield* Effect.sync(() => Date.now());
            yield* container.start({ enableInternet: true });
            yield* port.fetch(HttpClientRequest.get("http://container/")).pipe(
              Effect.flatMap((r) => r.text),
              Effect.retry({
                schedule: Schedule.min([
                  Schedule.exponential("1 second"),
                  Schedule.spaced("5 seconds"),
                ]),
                times: 40,
              }),
            );
            const readyMs = (yield* Effect.sync(() => Date.now())) - start;
            return { readyMs };
          }),
        shutdown: () => container.destroy().pipe(Effect.ignore),
      };
    });
  }),
) {}
