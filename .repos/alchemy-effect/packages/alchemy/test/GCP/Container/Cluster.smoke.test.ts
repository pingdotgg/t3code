import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Kubernetes from "@/Kubernetes";
import type {
  IdentityState,
  RegistryState,
} from "@/Kubernetes/ClusterAdapter.ts";
import type { Connection } from "@/Kubernetes/Connection.ts";
import { connectCluster, readObject } from "@/Kubernetes/internal/client.ts";
import type { KubernetesObjectRef } from "@/Kubernetes/internal/objects.ts";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as container from "@distilled.cloud/gcp/container_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { spawnSync } from "node:child_process";
import GkeSmokeApiLive, { GkeSmokeApi } from "./fixtures/smoke-api.ts";
import GkeSmokeJob from "./fixtures/smoke-job.ts";
import {
  JOB_MARKER_BODY,
  JOB_MARKER_KEY,
  SMOKE_NAMESPACE,
  SmokeBucket,
  SmokeCluster,
  SmokeNamespace,
} from "./fixtures/smoke-resources.ts";
import { SMOKE_REGION } from "../zones.ts";

/**
 * GKE flagship smoke — the GCP counterpart of the ECS Task / EKS path:
 *
 * Autopilot `GCP.Container.Cluster` → an Effect-native
 * `Kubernetes.Deployment` behind a GKE LoadBalancer, bound to a Cloud
 * Storage bucket (`GCP.Storage.ReadWriteBucket`) through Workload
 * Identity → an inline-effect `Kubernetes.Job` that writes a marker object
 * through `GCP.Storage.WriteBucket`. Every side effect is verified
 * out-of-band via distilled, and teardown is proven clean.
 *
 * Autopilot creation alone takes ~10 minutes, so the smoke only runs with
 * `GCP_TEST_SLOW=1` (and never under `--fast`). The images are built
 * locally, so it also needs a Docker daemon.
 */

const dockerAvailable = (() => {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 })
        .status === 0
    );
  } catch {
    return false;
  }
})();

const skip =
  !process.env.GCP_TEST_SLOW || !!process.env.FAST || !dockerAvailable;

const testOptions = {
  providers: Layer.mergeAll(GCP.providers(), Kubernetes.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
// Durable (file-namespaced) state: a hard-killed run leaves resumable rows
// so the next run's up-front destroy reclaims the cluster.
const sharedStack = Core.scratchStack(
  testOptions,
  "GkeSmoke",
  "test/GCP/Container/Cluster.smoke.test.ts",
);

interface StackOutputs {
  clusterName: string;
  connection: Connection;
  bucketName: string;
  url: string | undefined;
  apiServiceAccount: string;
  apiIdentity: IdentityState | undefined;
  apiRegistry: RegistryState | undefined;
  jobServiceAccount: string;
  jobIdentity: IdentityState | undefined;
  jobRegistry: RegistryState | undefined;
  jobObjects: KubernetesObjectRef[];
}

let outputs: StackOutputs;
let baseUrl: string;

class NotReady extends Data.TaggedError("NotReady")<{
  readonly detail: string;
}> {}

class StillExists extends Data.TaggedError("StillExists")<{
  readonly what: string;
}> {}

const repositoryOf = (registry: RegistryState | undefined) =>
  registry?.kind === "gcp-artifact-registry" ? registry.name : undefined;

const memberOf = (identity: IdentityState | undefined) =>
  identity?.kind === "gcp-workload-identity" ? identity.member : undefined;

const deployProgram = Effect.gen(function* () {
  const cluster = yield* SmokeCluster;
  const bucket = yield* SmokeBucket;
  yield* SmokeNamespace;
  const api = yield* GkeSmokeApi;
  const job = yield* GkeSmokeJob;
  return {
    clusterName: cluster.name,
    connection: cluster.connection,
    bucketName: bucket.bucketName,
    url: api.url,
    apiServiceAccount: api.serviceAccountName,
    apiIdentity: api.identity,
    apiRegistry: api.registry,
    jobServiceAccount: job.serviceAccountName,
    jobIdentity: job.identity,
    jobRegistry: job.registry,
    jobObjects: job.kubernetesObjects,
  };
}).pipe(Effect.provide(GkeSmokeApiLive));

/** GET/PUT returning status + text; transport errors propagate. */
const call = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((text) => ({ status: response.status, text })),
      ),
    ),
  );

/**
 * Re-run `attempt` every 10s until `ready` accepts its value. Transport
 * errors count as not ready — a fresh load balancer refuses connections
 * until its backends pass health checks.
 */
const until = <A, E, R>(
  attempt: Effect.Effect<A, E, R>,
  ready: (value: A) => boolean,
  times: number,
) =>
  attempt.pipe(
    Effect.filterOrFail(
      ready,
      (value) => new NotReady({ detail: JSON.stringify(value) }),
    ),
    Effect.tapError((error) => Effect.logDebug(`not ready: ${String(error)}`)),
    Effect.retry({ schedule: Schedule.spaced("10 seconds"), times }),
  );

/** Bounded wait until an out-of-band probe reports the resource gone. */
const waitUntilGone = <E, R>(
  what: string,
  probe: Effect.Effect<boolean, E, R>,
) =>
  probe.pipe(
    Effect.flatMap((gone) =>
      gone ? Effect.void : Effect.fail(new StillExists({ what })),
    ),
    Effect.retry({
      while: (e) => e instanceof StillExists,
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );

/** The KSA Workload Identity principals, derived independently. */
const expectedPrincipals = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const { name } = yield* resourcemanager.getProjects({
    name: `projects/${project}`,
  });
  const number = (name ?? "").split("/").pop()!;
  const principal = (ksa: string) =>
    `principal://iam.googleapis.com/projects/${number}/locations/global/` +
    `workloadIdentityPools/${project}.svc.id.goog/subject/ns/${SMOKE_NAMESPACE}/sa/${ksa}`;
  return {
    api: principal(outputs.apiServiceAccount),
    job: principal(outputs.jobServiceAccount),
  };
});

/** Load-balancer plumbing GKE created for Services in the smoke namespace. */
const namespaceLoadBalancers = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const marker = `"kubernetes.io/service-name":"${SMOKE_NAMESPACE}/`;
  const rules = yield* compute.listForwardingRules({
    project,
    region: SMOKE_REGION,
  });
  const backends = yield* compute.listRegionBackendServices({
    project,
    region: SMOKE_REGION,
  });
  return [
    ...(rules.items ?? []).filter((r) =>
      (r.description ?? "").includes(marker),
    ),
    ...(backends.items ?? []).filter((b) =>
      (b.description ?? "").includes(marker),
    ),
  ].map((item) => item.name);
});

describe.skipIf(skip).sequential(
  "GKE smoke",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:container",
      "provider:gcp:storage",
      "provider:gcp:artifactregistry",
      "provider:kubernetes",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* Effect.logInfo("GKE smoke: destroying previous stack");
        yield* sharedStack.destroy();

        yield* Effect.logInfo("GKE smoke: deploying stack (~10 min)");
        outputs = (yield* sharedStack.deploy(deployProgram)) as StackOutputs;
        expect(outputs.url).toMatch(/^http:\/\/[^/]+:3000$/);
        baseUrl = outputs.url!.replace(/\/+$/, "");

        yield* Effect.logInfo(`GKE smoke: probing ${baseUrl}/health`);
        const health = yield* until(
          call(HttpClientRequest.get(`${baseUrl}/health`)),
          (r) => r.status === 200,
          60,
        );
        expect(JSON.parse(health.text)).toEqual({ ok: true });
      }),
      { timeout: 1_800_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 1_800_000 });

    test.provider(
      "Workload Identity grants land on each KSA principal (bucket IAM)",
      (_stack) =>
        Effect.gen(function* () {
          const principals = yield* expectedPrincipals;
          // The adapter's recorded members are the same principals.
          expect(memberOf(outputs.apiIdentity)).toBe(principals.api);
          expect(memberOf(outputs.jobIdentity)).toBe(principals.job);

          const policy = yield* storage.getIamPolicyBuckets({
            bucket: outputs.bucketName,
            optionsRequestedPolicyVersion: 3,
          });
          const rolesOf = (member: string) =>
            (policy.bindings ?? [])
              .filter((b) => (b.members ?? []).includes(member))
              .map((b) => b.role);
          // Least privilege, on the bucket only.
          expect(rolesOf(principals.api)).toEqual(["roles/storage.objectUser"]);
          expect(rolesOf(principals.job)).toEqual(["roles/storage.objectUser"]);

          // Nothing was granted at the project level.
          const { project } = yield* GcpEnvironment.current;
          const projectPolicy = yield* resourcemanager.getIamPolicyProjects({
            resource: `projects/${project}`,
            body: { options: { requestedPolicyVersion: 3 } },
          });
          expect(
            (projectPolicy.bindings ?? []).filter((b) =>
              (b.members ?? []).some(
                (m) => m === principals.api || m === principals.job,
              ),
            ),
          ).toEqual([]);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:container", "live"],
        timeout: 120_000,
      },
    );

    test.provider(
      "the Deployment reads and writes the bucket from the pod through the LoadBalancer",
      (_stack) =>
        Effect.gen(function* () {
          const key = "api/round-trip.txt";
          const body = yield* Effect.sync(
            () =>
              `written through the GKE load balancer ${crypto.randomUUID()}`,
          );

          // A fresh bucket grant may take a moment to reach Storage; the
          // pod answers 500 until then.
          const put = yield* until(
            call(
              HttpClientRequest.put(`${baseUrl}/objects/${key}`).pipe(
                HttpClientRequest.bodyText(body, "text/plain"),
              ),
            ),
            (r) => r.status !== 500,
            30,
          );
          expect(put.status).toBe(200);
          expect(JSON.parse(put.text)).toEqual({ key, read: body });

          // Out-of-band: the object is real.
          const object = yield* storage.getObjects({
            bucket: outputs.bucketName,
            object: key,
          });
          expect(object.size).toBe(
            String(new TextEncoder().encode(body).length),
          );
          expect(object.contentType).toBe("text/plain");

          const missing = yield* call(
            HttpClientRequest.get(`${baseUrl}/objects/nope/missing.txt`),
          );
          expect(missing.status).toBe(404);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:container", "live"],
        timeout: 600_000,
      },
    );

    test.provider(
      "the inline-effect Job completes and its marker exists",
      (_stack) =>
        Effect.gen(function* () {
          const ref = outputs.jobObjects.find((o) => o.kind === "Job");
          expect(ref).toBeDefined();
          const transport = yield* connectCluster(outputs.connection);

          // Autopilot provisions a node for the pod on demand; the pod
          // retries under the Job's backoff while the grant propagates.
          const job = yield* until(
            readObject({ transport, object: ref! }).pipe(
              Effect.map(
                (o) =>
                  (o as { status?: { succeeded?: number; failed?: number } })
                    .status ?? {},
              ),
            ),
            (status) => (status.succeeded ?? 0) >= 1,
            60,
          );
          expect(job.succeeded).toBe(1);

          // Out-of-band: the marker object the Job wrote.
          const marker = yield* storage.getObjects({
            bucket: outputs.bucketName,
            object: JOB_MARKER_KEY,
          });
          expect(marker.size).toBe(
            String(new TextEncoder().encode(JOB_MARKER_BODY).length),
          );

          // …and the Deployment's read binding serves it back.
          const read = yield* call(
            HttpClientRequest.get(`${baseUrl}/objects/${JOB_MARKER_KEY}`),
          );
          expect(read.status).toBe(200);
          expect(read.text).toBe(JOB_MARKER_BODY);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:container", "live"],
        timeout: 720_000,
      },
    );

    test.provider(
      "destroy leaves no cluster, load balancer, bucket, grants, or repository",
      (_stack) =>
        Effect.gen(function* () {
          const principals = yield* expectedPrincipals;
          const repositories = [outputs.apiRegistry, outputs.jobRegistry]
            .map(repositoryOf)
            .filter((name) => name !== undefined);
          expect(repositories).toHaveLength(2);

          yield* sharedStack.destroy();

          yield* waitUntilGone(
            "cluster",
            container
              .getProjectsLocationsClusters({ name: outputs.clusterName })
              .pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
          );
          yield* waitUntilGone(
            "bucket",
            storage.getBuckets({ bucket: outputs.bucketName }).pipe(
              Effect.as(false),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            ),
          );
          for (const name of repositories) {
            yield* waitUntilGone(
              `repository ${name}`,
              artifactregistry.getProjectsLocationsRepositories({ name }).pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
            );
          }
          // The LoadBalancer Service was drained before the cluster went,
          // so GKE left no forwarding rule or backend service behind.
          yield* waitUntilGone(
            "load balancer",
            namespaceLoadBalancers.pipe(
              Effect.map((left) => left.length === 0),
            ),
          );
          // No grant outlives the workloads at the project level either.
          const { project } = yield* GcpEnvironment.current;
          const projectPolicy = yield* resourcemanager.getIamPolicyProjects({
            resource: `projects/${project}`,
            body: { options: { requestedPolicyVersion: 3 } },
          });
          expect(
            (projectPolicy.bindings ?? []).filter((b) =>
              (b.members ?? []).some(
                (m) => m === principals.api || m === principals.job,
              ),
            ),
          ).toEqual([]);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:container", "live"],
        timeout: 1_200_000,
        retry: 0,
      },
    );
  },
);
