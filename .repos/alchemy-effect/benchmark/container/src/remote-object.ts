import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { RemoteContainer } from "./remote-container.ts";

/**
 * Durable Object backing one remote (non-effectful) container instance.
 * `boot()` blocks until the container's HTTP server answers on its TCP port.
 * NOTE: the authoritative cold-start clock runs in the Worker AROUND the whole
 * DO call — the container layer eagerly starts the container during DO
 * construction, so a clock started here would miss part of the start.
 */
export class RemoteObject extends Cloudflare.DurableObject<RemoteObject>()(
  "BenchRemoteObject",
  Effect.gen(function* () {
    const container = yield* RemoteContainer;

    return Effect.gen(function* () {
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        boot: () =>
          Effect.gen(function* () {
            const start = yield* Effect.sync(() => Date.now());
            yield* fetch(HttpClientRequest.get("http://container/")).pipe(
              Effect.flatMap((r) => r.text),
              Effect.retry({
                schedule: Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("5 seconds")]),
                times: 40,
              }),
            );
            const readyMs = (yield* Effect.sync(() => Date.now())) - start;
            return { readyMs };
          }),
        shutdown: () => container.destroy().pipe(Effect.ignore),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(RemoteContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
