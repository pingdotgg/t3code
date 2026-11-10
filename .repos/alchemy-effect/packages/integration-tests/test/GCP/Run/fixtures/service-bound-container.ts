import * as GCP from "@alchemy.run/gcp";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import Worker from "./container-worker.ts";

/**
 * Cloud Run Service that binds the `Worker` sidecar and calls it over
 * `localhost`. Deployed from {@link ../Service.test.ts}.
 */
export default class BoundContainerService extends GCP.Run.Service<BoundContainerService>()(
  "BoundContainerService",
  {
    main: import.meta.url,
    location: "us-central1",
    invokerIamDisabled: true,
    startupProbe: { httpGet: { path: "/health" }, periodSeconds: 2, failureThreshold: 30 },
  },
  Effect.gen(function* () {
    const worker = yield* GCP.Run.bindContainer(Worker);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/health")) return HttpServerResponse.text("ok");
        const greeting = yield* worker.greet("sam");
        const counts = yield* worker.count().pipe(Stream.runCollect);
        const published = yield* worker.publish("from a sidecar");
        const staticStatus = yield* worker.staticStatus();
        const health = yield* worker.fetch(HttpClientRequest.get("/health"));
        return yield* HttpServerResponse.json({
          greeting,
          counts: [...counts],
          published,
          staticStatus,
          health: yield* health.text,
        });
      }).pipe(
        // Surface the failing call in the response so a test failure shows it.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
