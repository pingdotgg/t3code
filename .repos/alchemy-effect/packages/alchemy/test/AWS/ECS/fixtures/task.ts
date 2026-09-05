import * as AWS from "@/AWS";
import { ServerHost } from "@/Server/Process.ts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * End-to-end fixture for `AWS.ECS.Task`: a long-running server.
 *
 * - `yield* ServerHost` + `host.run(...)` registers a background loop that
 *   increments a counter once a second (this is the pattern from issue #706).
 * - the returned `{ fetch }` handler is served over HTTP by the container's Bun
 *   HTTP server. `/ticks` reports the counter so the test can prove the
 *   background loop is actually running inside the deployed Fargate task.
 */
export default class TestTask extends AWS.ECS.Task<TestTask>()(
  "EcsE2ETask",
  {
    main: import.meta.filename,
    cpu: 256,
    memory: 512,
    port: 3000,
    // Build/run on ARM64 so the image built on an Apple Silicon host matches
    // the Fargate runtime architecture (Graviton).
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
    // Docker Hub's `oven/bun` image; the public.ecr.aws default mirror
    // aggressively rate-limits anonymous pulls (429) during local builds.
    image: "oven/bun:1",
  },
  Effect.gen(function* () {
    const host = yield* ServerHost;
    const ticks = yield* Ref.make(0);

    // Long-running background loop (the `host.run` pattern from #706).
    yield* host.run(
      Ref.update(ticks, (n) => n + 1).pipe(
        Effect.repeat(Schedule.spaced("1 second")),
        Effect.asVoid,
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://task");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        if (url.pathname === "/ticks") {
          return yield* HttpServerResponse.json({
            ticks: yield* Ref.get(ticks),
          });
        }
        return HttpServerResponse.text("hello from ecs task");
      }),
    };
  }),
) {}
