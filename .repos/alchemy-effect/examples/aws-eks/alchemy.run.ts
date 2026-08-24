/**
 * A "guestbook" app on EKS Auto Mode that exercises the full Kubernetes
 * container surface:
 *
 * - a stack-owned network + `compute: "auto"` cluster + DynamoDB table +
 *   a namespace applied as a raw manifest via `EKS.Manifest` (`src/infra.ts`),
 * - `Api` — an effectful `AWS.EKS.Deployment` (bundled `main:` image source)
 *   behind an internet-facing NLB with DynamoDB bindings on the pod-identity
 *   role, plus the typed `podTemplate` escape hatch (`src/Api.ts`),
 * - `Web` — an EXTERNAL `AWS.EKS.Deployment` (registry `image:` source, no
 *   Effect runtime in the container), nginx behind its own NLB,
 * - `SeedJob` — an inline-effect one-shot `AWS.EKS.Job` (`{ run }`) that
 *   seeds the guestbook table when the batch/v1 Job is applied on deploy
 *   (`src/SeedJob.ts`).
 */
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import ApiLive, { Api } from "./src/Api.ts";
import {
  EntriesTable,
  GuestbookCluster,
  GuestbookNamespace,
} from "./src/infra.ts";
import SeedJob from "./src/SeedJob.ts";

export default Alchemy.Stack(
  "AwsEksExample",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const cluster = yield* GuestbookCluster;
    const table = yield* EntriesTable;
    const ns = yield* GuestbookNamespace;

    // ── Api — effectful server in the TAGGED form (bundled `main:`).
    // `ApiLive` (the `Api.make(...)` Layer, provided below) carries the
    // props + init program; its init declares the DynamoDB bindings that
    // land on the generated pod-identity role; see src/Api.ts.
    const api = yield* Api;

    // ── Web — EXTERNAL deployment: a pre-built registry image (mirrored
    // into ECR), no Effect runtime in the container. Auto Mode's built-in
    // controller provisions the NLB for the LoadBalancer Service; port 80,
    // so `web.url` carries no port suffix.
    const web = yield* AWS.EKS.Deployment("Web", {
      cluster,
      image: "public.ecr.aws/nginx/nginx:1.27",
      namespace: ns.name,
      replicas: 2,
      port: 80,
      serviceType: "LoadBalancer",
      resources: {
        requests: { cpu: "50m", memory: "64Mi" },
        limits: { cpu: "250m", memory: "128Mi" },
      },
    });

    // ── SeedJob — inline-effect one-shot Job; runs to completion on deploy
    // (Kubernetes runs a batch/v1 Job as soon as it is applied).
    const seedJob = yield* SeedJob;

    return {
      clusterName: cluster.clusterName,
      // Full URL including the Service port (http://<nlb-hostname>:3000).
      apiUrl: api.url,
      webUrl: web.url,
      tableName: table.tableName,
      namespace: ns.name,
      seedJobName: seedJob.jobName,
    };
  }).pipe(Effect.provide(ApiLive)),
);
