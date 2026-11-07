import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Second deploy step of {@link ./service-bound-container.ts}: the same
 * service with its `Worker` binding removed. The revision must drop the
 * sidecars.
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
    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }),
) {}
