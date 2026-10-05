import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import RmaBindingsHost, { OnPrem } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "RapidMigrationAssessmentBindings",
);

// Needs the Rapid Migration Assessment API (disabled on the testing
// project). Set GCP_TEST_RMA=1 on a project with the API enabled.
const runLifecycle = !!process.env.GCP_TEST_RMA && !process.env.FAST;

let baseUrl: string;
let member: string;
let collectorName: string;

/** The operation a probe started exists and targets the bound collector. */
const expectOperationOnCollector = (operation: rma.Operation) =>
  Effect.gen(function* () {
    expect(operation.name).toContain("/operations/");
    const live = yield* rma.getProjectsLocationsOperations({
      name: operation.name!,
    });
    expect(live.name).toEqual(operation.name);
    expect(JSON.stringify(live.metadata ?? {})).toContain(collectorName);
  });

/** `[role, condition]` the host holds on the project. */
const hostProjectGrants = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const policy = yield* resourcemanager.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  return (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => [binding.role, binding.condition]);
});

describe.skipIf(!dockerAvailable || !runLifecycle)(
  "RapidMigrationAssessment Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:rapidmigrationassessment",
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
            const host = yield* RmaBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              collector: (yield* OnPrem).name,
            };
          }),
        );
        baseUrl = out.uri!;
        member = `serviceAccount:${out.serviceAccount!}`;
        collectorName = out.collector;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    // RMA has no resource-level IAM; rma.runner is granted on the project.
    const runnerOnProject = [["roles/rma.runner", undefined]];

    describe("PauseCollector", () => {
      test.provider(
        "starts a pause operation on the collector",
        (_stack) =>
          Effect.gen(function* () {
            const operation = yield* expectProbe<rma.Operation>(
              baseUrl,
              "pause",
            );
            yield* expectOperationOnCollector(operation);
            expect(yield* hostProjectGrants).toEqual(runnerOnProject);
          }),
        {
          tags: [
            "provider:gcp",
            "provider:gcp:rapidmigrationassessment",
            "live",
          ],
          timeout: 600_000,
        },
      );
    });

    describe("ResumeCollector", () => {
      test.provider(
        "starts a resume operation on the collector",
        (_stack) =>
          Effect.gen(function* () {
            const operation = yield* expectProbe<rma.Operation>(
              baseUrl,
              "resume",
            );
            yield* expectOperationOnCollector(operation);
            expect(yield* hostProjectGrants).toEqual(runnerOnProject);
          }),
        {
          tags: [
            "provider:gcp",
            "provider:gcp:rapidmigrationassessment",
            "live",
          ],
          timeout: 600_000,
        },
      );
    });

    describe("RegisterCollector", () => {
      test.provider(
        "starts a register operation on the collector",
        (_stack) =>
          Effect.gen(function* () {
            const operation = yield* expectProbe<rma.Operation>(
              baseUrl,
              "register",
            );
            yield* expectOperationOnCollector(operation);
            expect(yield* hostProjectGrants).toEqual(runnerOnProject);
          }),
        {
          tags: [
            "provider:gcp",
            "provider:gcp:rapidmigrationassessment",
            "live",
          ],
          timeout: 600_000,
        },
      );
    });
  },
);
