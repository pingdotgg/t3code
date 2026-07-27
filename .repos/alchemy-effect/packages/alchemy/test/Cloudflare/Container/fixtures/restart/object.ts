import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { RestartContainer } from "./container.ts";

/**
 * Durable Object backing one {@link RestartContainer} instance, exposing the
 * levers the restart tests need:
 *  - `ping`    — RPC into the container (forces start + proves it's up)
 *  - `running` — the raw `container.running` flag
 *  - `stop`    — hard stop from the DO side (`destroy` = SIGKILL)
 *  - `crash`   — make the container process exit on its own (non-zero)
 */
export class RestartObject extends Cloudflare.DurableObject<RestartObject>()(
  "RestartObject",
  Effect.gen(function* () {
    const container = yield* RestartContainer;

    return Effect.gen(function* () {
      return {
        ping: () => container.ping(),
        running: () => container.running,
        // Hard stop from the DO side. Exercises the "container stopped, then
        // requested again" auto-restart path.
        stop: () => container.destroy(),
        // Crash from inside the container process. Exercises the
        // monitor-observed-exit auto-restart path.
        crash: () =>
          Effect.gen(function* () {
            const { fetch } = yield* container.getTcpPort(3000);
            const response = yield* fetch(
              HttpClientRequest.get("http://container/exit"),
            );
            return yield* response.text;
          }).pipe(Effect.orDie),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(RestartContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
