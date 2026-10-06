import * as GCP from "@/GCP";
import * as Kubernetes from "@/Kubernetes";
import * as Effect from "effect/Effect";
import { SMOKE_REGION } from "../../zones.ts";

/**
 * Shared infrastructure for the GKE smoke. Resources are memoized by
 * logical id, so the stack program and the workloads' props/init effects
 * converge on the same instances.
 */

/** The Kubernetes namespace every smoke workload runs in. */
export const SMOKE_NAMESPACE = "gke-smoke";

/** The object the one-shot Job writes through its binding. */
export const JOB_MARKER_KEY = "job/marker.txt";
export const JOB_MARKER_BODY = "written by the GKE smoke job";

/**
 * Autopilot: Google provisions nodes from the pods' resource requests.
 * Autopilot clusters are always regional.
 */
export const SmokeCluster = GCP.Container.Cluster("GkeSmokeCluster", {
  location: SMOKE_REGION,
  autopilot: true,
  releaseChannel: "REGULAR",
});

/** The bucket both workloads reach through Workload Identity. */
export const SmokeBucket = GCP.Storage.Bucket("GkeSmokeBucket", {
  location: SMOKE_REGION.toUpperCase(),
  uniformBucketLevelAccess: true,
  forceDestroy: true,
});

/** The namespace, applied as a raw manifest. */
export const SmokeNamespace = Effect.gen(function* () {
  const cluster = yield* SmokeCluster;
  return yield* Kubernetes.Manifest("GkeSmokeNamespace", {
    cluster,
    manifest: {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: SMOKE_NAMESPACE },
    },
  });
});

/** Autopilot pins limits to requests; keep both small and equal. */
export const smokeResources = {
  requests: { cpu: "250m", memory: "512Mi" },
  limits: { cpu: "250m", memory: "512Mi" },
};
