import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import { CAPACITY_REGION } from "../zones.ts";
import DataprocBindingsHost, { Jobs } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DataprocBindings");

// Cluster create + delete takes ~8 minutes (observed 475s).
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

let baseUrl: string;
let hostAccount: string;
let clusterName: string;
let clusterResource: string;
let project: string;

const rolesOf = (
  bindings: ReadonlyArray<{ role?: string; members?: ReadonlyArray<string> }>,
) =>
  bindings
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => binding.role)
    .sort();

const projectRoles = Effect.gen(function* () {
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  return rolesOf(policy.bindings ?? []);
});

describe.skipIf(!dockerAvailable || !runLifecycle)(
  "Dataproc Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:dataproc", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* DataprocBindingsHost;
            const cluster = yield* Jobs;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              clusterName: cluster.clusterName,
              name: cluster.name,
              project: cluster.project,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        clusterName = out.clusterName;
        clusterResource = out.name;
        project = out.project;
      }),
      { timeout: 1_800_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 1_200_000 });

    describe("GetCluster", () => {
      test.provider(
        "reads the cluster as the host's service account, granted on the cluster only",
        (_stack) =>
          Effect.gen(function* () {
            const cluster = yield* expectProbe<dataproc.Cluster>(
              baseUrl,
              "getCluster",
            );
            expect(cluster.clusterName).toEqual(clusterName);
            expect(cluster.status?.state).toEqual("RUNNING");

            const policy = yield* dataproc.getIamPolicyProjectsRegionsClusters({
              resource: clusterResource,
            });
            expect(rolesOf(policy.bindings ?? [])).toEqual([
              "roles/dataproc.viewer",
            ]);
            expect(yield* projectRoles).not.toContain("roles/dataproc.viewer");
          }),
        {
          tags: ["provider:gcp", "provider:gcp:dataproc", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("SubmitJob", () => {
      test.provider(
        "submits a job to the cluster as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const job = yield* expectProbe<dataproc.Job>(baseUrl, "submitJob");
            expect(job.placement?.clusterName).toEqual(clusterName);
            expect(job.reference?.jobId).toEqual(expect.any(String));

            const live = yield* dataproc.getProjectsRegionsJobs({
              projectId: project,
              region: CAPACITY_REGION,
              jobId: job.reference!.jobId!,
            });
            expect(live.placement?.clusterName).toEqual(clusterName);
            expect(live.pigJob?.queryList?.queries).toEqual(["DUMP;"]);

            // dataproc.jobs.create is checked on the project.
            expect(yield* projectRoles).toEqual(["roles/dataproc.editor"]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:dataproc", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
