import * as AWS from "@/AWS";
import { ServerHost } from "@/Server/Process.ts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * End-to-end fixture for the Effect-native `AWS.AppRunner.Service` form: an
 * inline Effect HTTP program bundled + containerized + pushed to a managed
 * ECR repository and deployed as an App Runner service.
 *
 * - `yield* ServerHost` + `host.run(...)` registers a background loop that
 *   increments a counter once a second.
 * - the returned `{ fetch }` handler is served over HTTP by the container's
 *   Bun HTTP server on the App Runner-injected `PORT`. `/ticks` reports the
 *   counter so the test can prove the background loop actually runs inside
 *   the deployed service.
 */
export default class TestService extends AWS.AppRunner.Service<TestService>()(
  "AppRunnerE2EService",
  {
    main: import.meta.filename,
    serviceName: "alchemy-test-apprunner-e2e",
    port: 3000,
    instanceConfiguration: { cpu: "256", memory: "512" },
    healthCheckConfiguration: { protocol: "HTTP", path: "/health" },
    // Docker Hub's `oven/bun` image; the public.ecr.aws default mirror
    // aggressively rate-limits anonymous pulls (429) during local builds.
    docker: { base: "oven/bun:1" },
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
        return HttpServerResponse.text("hello from app runner");
      }),
    };
  }),
) {}
