import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as dataflow from "@distilled.cloud/gcp/dataflow_v1b3";
import * as datapipelines from "@distilled.cloud/gcp/datapipelines_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import DataPipelinesBindingsHost, {
  BindBatch,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DataPipelinesBindings");

let baseUrl: string;
let pipelineName: string;
let hostAccount: string;

/** Roles the host's service account holds on the project policy. */
const projectRoles = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  return (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => ({
      role: binding.role,
      condition: binding.condition?.expression,
    }))
    .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? ""));
});

// Data Pipelines has no resource-level IAM, so both bindings grant on the
// project (unconditioned).
const expectedProjectRoles = [
  { role: "roles/datapipelines.admin", condition: undefined },
  { role: "roles/datapipelines.invoker", condition: undefined },
];

// RunPipeline must run before StopPipeline archives the pipeline.
describe.skipIf(!dockerAvailable)(
  "DataPipelines Bindings",
  {
    sequential: true,
    tags: [
      "provider:gcp",
      "provider:gcp:datapipelines",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* DataPipelinesBindingsHost;
            const pipeline = yield* BindBatch;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              pipeline: pipeline.name,
            };
          }),
        );
        baseUrl = out.uri!;
        pipelineName = out.pipeline;
        hostAccount = out.serviceAccount!;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("RunPipeline", () => {
      test.provider(
        "launches a pipeline job as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const ran =
              yield* expectProbe<datapipelines.GoogleCloudDatapipelinesV1RunPipelineResponse>(
                baseUrl,
                "runPipeline",
              );
            expect(ran.job?.id).toEqual(expect.any(String));

            const jobIds = yield* datapipelines
              .listProjectsLocationsPipelinesJobs({ parent: pipelineName })
              .pipe(
                Effect.map((page) => (page.jobs ?? []).map((job) => job.id)),
                Effect.repeat({
                  schedule: Schedule.spaced("3 seconds"),
                  until: (ids) => ids.includes(ran.job?.id),
                  times: 20,
                }),
              );
            expect(jobIds).toContain(ran.job?.id);

            // The pipeline job is a real Dataflow job (Word Count on one file:
            // it finishes, or fails once the scratch bucket is destroyed, on
            // its own within minutes).
            const { project } = yield* GcpEnvironment.current;
            const job = yield* dataflow.getProjectsLocationsJobs({
              projectId: project,
              location: "us-central1",
              jobId: ran.job!.id!,
            });
            expect(job.id).toEqual(ran.job?.id);

            expect(yield* projectRoles).toEqual(expectedProjectRoles);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:datapipelines", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("StopPipeline", () => {
      test.provider(
        "archives the pipeline as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const stopped =
              yield* expectProbe<datapipelines.GoogleCloudDatapipelinesV1Pipeline>(
                baseUrl,
                "stopPipeline",
              );
            expect(stopped.name).toEqual(pipelineName);
            expect(stopped.state).toEqual("STATE_ARCHIVED");

            const live = yield* datapipelines.getProjectsLocationsPipelines({
              name: pipelineName,
            });
            expect(live.state).toEqual("STATE_ARCHIVED");

            expect(yield* projectRoles).toEqual(expectedProjectRoles);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:datapipelines", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
