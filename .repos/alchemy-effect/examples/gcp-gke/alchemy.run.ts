/**
 * A "guestbook" app on GKE Autopilot that exercises the full Kubernetes
 * container surface:
 *
 * - a stack-owned Autopilot cluster + Firestore database + a namespace
 *   applied as a raw manifest via `Kubernetes.Manifest` (`src/infra.ts`),
 * - `Api` — an effectful `Kubernetes.Deployment` (bundled `main:` image source)
 *   behind an external Network Load Balancer, with a Firestore binding
 *   granted to its Kubernetes ServiceAccount's Workload Identity principal,
 *   plus the typed `podTemplate` escape hatch (`src/Api.ts`),
 * - `Web` — an EXTERNAL `Kubernetes.Deployment` (registry `image:` source, no
 *   Effect runtime in the container), nginx behind its own load balancer,
 * - `SeedJob` — an inline-effect one-shot `Kubernetes.Job` (`{ run }`) that
 *   seeds the guestbook database when the batch/v1 Job is applied on deploy
 *   (`src/SeedJob.ts`).
 */
import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ApiLive, { Api } from "./src/Api.ts";
import {
  EntriesDatabase,
  GuestbookCluster,
  GuestbookNamespace,
} from "./src/infra.ts";
import SeedJob from "./src/SeedJob.ts";

export default Alchemy.Stack(
  "GcpGkeExample",
  {
    providers: Layer.mergeAll(GCP.providers(), Kubernetes.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const cluster = yield* GuestbookCluster;
    const database = yield* EntriesDatabase;
    const ns = yield* GuestbookNamespace;

    // ── Api — effectful server in the TAGGED form (bundled `main:`).
    // `ApiLive` (the `Api.make(...)` Layer, provided below) carries the
    // props + init program; its init declares the Firestore binding whose
    // grant lands on the Deployment's Workload Identity principal; see
    // src/Api.ts.
    const api = yield* Api;

    // ── Web — EXTERNAL deployment: a pre-built registry image (mirrored
    // into Artifact Registry), no Effect runtime in the container. GKE
    // provisions a load balancer for the LoadBalancer Service; port 80,
    // so `web.url` carries no port suffix.
    const web = yield* Kubernetes.Deployment("Web", {
      cluster,
      image: "nginx:1.27",
      namespace: ns.name,
      replicas: 2,
      port: 80,
      serviceType: "LoadBalancer",
      resources: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "250m", memory: "512Mi" },
      },
    });

    // ── SeedJob — inline-effect one-shot Job; runs to completion on deploy
    // (Kubernetes runs a batch/v1 Job as soon as it is applied).
    const seedJob = yield* SeedJob;

    return {
      clusterId: cluster.clusterId,
      clusterName: cluster.name,
      // Full URL including the Service port (http://<ip>:3000).
      apiUrl: api.url,
      webUrl: web.url,
      databaseName: database.name,
      namespace: ns.name,
      apiServiceAccount: api.serviceAccountName,
      seedJobName: seedJob.jobName,
      seedJobServiceAccount: seedJob.serviceAccountName,
    };
  }).pipe(Effect.provide(ApiLive)),
);
