import * as GCP from "@/GCP";
import * as Kubernetes from "@/Kubernetes";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  SmokeBucket,
  SmokeCluster,
  SmokeNamespace,
  smokeResources,
} from "./smoke-resources.ts";

/**
 * Effect-native `Kubernetes.Deployment` behind a GKE LoadBalancer. The
 * `GCP.Storage.ReadWriteBucket` binding grants `roles/storage.objectUser`
 * on the bucket to the Deployment's KSA Workload Identity principal; the
 * pod authenticates through the GKE metadata server.
 *
 * - `GET /health` — readiness.
 * - `PUT /objects/<key>` — write the request body, read it back.
 * - `GET /objects/<key>` — read an object (404 when missing).
 */
export class GkeSmokeApi extends Kubernetes.Deployment<GkeSmokeApi>()(
  "GkeSmokeApi",
) {}

export default GkeSmokeApi.make(
  Effect.gen(function* () {
    const cluster = yield* SmokeCluster;
    const ns = yield* SmokeNamespace;
    return {
      cluster,
      main: import.meta.url,
      namespace: ns.name,
      port: 3000,
      replicas: 1,
      serviceType: "LoadBalancer" as const,
      resources: smokeResources,
    };
  }),
  Effect.gen(function* () {
    const bucket = yield* GCP.Storage.ReadWriteBucket(SmokeBucket);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const key = url.pathname.startsWith("/objects/")
          ? decodeURIComponent(url.pathname.slice("/objects/".length))
          : undefined;

        if (key !== undefined && request.method === "PUT") {
          const body = yield* request.text;
          yield* bucket.put(key, body, { contentType: "text/plain" });
          const read = yield* bucket.get(key);
          return yield* HttpServerResponse.json({
            key,
            read: read && new TextDecoder().decode(read.body),
          });
        }

        if (key !== undefined && request.method === "GET") {
          const read = yield* bucket.get(key);
          return read === undefined
            ? HttpServerResponse.text("not found", { status: 404 })
            : HttpServerResponse.text(new TextDecoder().decode(read.body));
        }

        return yield* HttpServerResponse.json({ ok: true });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(GCP.Storage.ReadWriteBucketHttp)),
);
