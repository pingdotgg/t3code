import * as Docker from "@/Docker";
import { ServerHost } from "@/Server/Process.ts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Fixed host port published through the swarm ingress. Deterministic (never
 * derived from the clock) and uncommon enough to avoid colliding with other
 * suites on the shared local daemon.
 */
export const SERVICE_EXTERNAL_PORT = 43117;

/**
 * End-to-end fixture for the effectful `Docker.Service` platform: a
 * long-running server bundled from this module and deployed to the local
 * swarm.
 *
 * - `yield* ServerHost` + `host.run(...)` registers a background loop that
 *   increments a counter once a second.
 * - the returned `{ fetch }` handler is served over HTTP by the container's
 *   Bun HTTP server. `/ticks` reports the counter so the test can prove the
 *   background loop is actually running inside the deployed swarm task.
 */
export default class TestService extends Docker.Service<TestService>()(
  "DockerPlatformService",
  {
    main: import.meta.filename,
    port: 3000,
    ports: [{ external: SERVICE_EXTERNAL_PORT, internal: 3000 }],
    replicas: 1,
  },
  Effect.gen(function* () {
    const host = yield* ServerHost;
    const ticks = yield* Ref.make(0);

    // Long-running background loop (the `host.run` pattern).
    yield* host.run(
      Ref.update(ticks, (n) => n + 1).pipe(
        Effect.repeat(Schedule.spaced("1 second")),
        Effect.asVoid,
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://service");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        if (url.pathname === "/ticks") {
          return yield* HttpServerResponse.json({
            ticks: yield* Ref.get(ticks),
          });
        }
        return HttpServerResponse.text("hello from docker service");
      }),
    };
  }),
) {}
