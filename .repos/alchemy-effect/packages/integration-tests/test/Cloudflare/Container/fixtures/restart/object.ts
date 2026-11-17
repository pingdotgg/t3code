import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { RestartContainer } from "./container.ts";

/**
 * Durable Object backing one {@link RestartContainer} instance, exposing the
 * levers the restart tests need:
 *  - `ping`    — start the container (if stopped) and RPC into it
 *  - `running` — the raw `container.running` flag
 *  - `stop`    — hard stop from the DO side (`destroy` = SIGKILL)
 *  - `crash`   — make the container process exit on its own (non-zero)
 */
export class RestartObject extends Cloudflare.DurableObject<RestartObject>()(
  "RestartObject",
  Effect.gen(function* () {
    const container = yield* RestartContainer;

    return Effect.gen(function* () {
      // Starting is idempotent: calling it before every request restarts a
      // container that was stopped or crashed since the last one.
      const start = container.start({ enableInternet: true });
      return {
        ping: () => start.pipe(Effect.andThen(container.ping())),
        running: () => container.running,
        // Hard stop from the DO side. Exercises the "container stopped, then
        // started again by the next request" path.
        stop: () => container.destroy(),
        // Crash from inside the container process. Exercises the
        // monitor-observed-exit restart path.
        crash: () =>
          Effect.gen(function* () {
            yield* start;
            const { fetch } = yield* container.getTcpPort(3000);
            const response = yield* fetch(HttpClientRequest.get("http://container/exit"));
            return yield* response.text;
          }).pipe(Effect.orDie),
      };
    });
  }),
) {}
