import * as GCP from "@/GCP";
import * as Kubernetes from "@/Kubernetes";
import * as Effect from "effect/Effect";
import {
  JOB_MARKER_BODY,
  JOB_MARKER_KEY,
  SmokeBucket,
  SmokeCluster,
  SmokeNamespace,
  smokeResources,
} from "./smoke-resources.ts";

/**
 * Inline-effect one-shot `Kubernetes.Job`: writes the marker object through
 * a `GCP.Storage.WriteBucket` binding granted to the Job's KSA Workload
 * Identity principal, then exits. Kubernetes runs it as soon as it is
 * applied; a fresh bucket grant may take a moment to propagate, so the pod
 * retries under the Job's backoff.
 */
export default Kubernetes.Job(
  "GkeSmokeJob",
  Effect.gen(function* () {
    const cluster = yield* SmokeCluster;
    const ns = yield* SmokeNamespace;
    return {
      cluster,
      main: import.meta.url,
      namespace: ns.name,
      backoffLimit: 6,
      resources: smokeResources,
    };
  }),
  Effect.gen(function* () {
    const bucket = yield* GCP.Storage.WriteBucket(SmokeBucket);
    return {
      run: Effect.gen(function* () {
        yield* bucket.put(JOB_MARKER_KEY, JOB_MARKER_BODY, {
          contentType: "text/plain",
        });
        yield* Effect.log(`wrote ${JOB_MARKER_KEY}`);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(GCP.Storage.WriteBucketHttp)),
);
