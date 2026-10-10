import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import ComputeBindingsHost, { Vm } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ComputeBindings");

// Stop→TERMINATED→RUNNING on e2-micro takes several minutes end to end.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

let baseUrl: string;
let hostAccount: string;
let vm: { project: string; zone: string; instanceName: string };

/** Out-of-band instance status, read with the deployer's credentials. */
const liveStatus = Effect.suspend(() =>
  compute
    .getInstances({
      project: vm.project,
      zone: vm.zone,
      instance: vm.instanceName,
    })
    .pipe(Effect.map((instance) => instance.status)),
);

const waitForStatus = (status: string) =>
  liveStatus.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (current) => current === status,
      times: 60,
    }),
  );

/**
 * The instance-level roles the host's service account holds. GetInstance
 * grants compute.viewer; Start/Stop share compute.instanceAdmin.v1.
 */
const expectInstanceGrants = Effect.gen(function* () {
  const policy = yield* compute.getIamPolicyInstances({
    project: vm.project,
    zone: vm.zone,
    resource: vm.instanceName,
  });
  const roles = (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => binding.role)
    .sort();
  expect(roles).toEqual([
    "roles/compute.instanceAdmin.v1",
    "roles/compute.viewer",
  ]);

  const { project } = yield* GcpEnvironment.current;
  const projectPolicy = yield* resourcemanager.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  const projectRoles = (projectPolicy.bindings ?? []).filter((binding) =>
    (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
  );
  expect(projectRoles).toEqual([]);
});

describe.skipIf(!dockerAvailable || !runLifecycle)(
  "Compute Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:compute", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* ComputeBindingsHost;
            const instance = yield* Vm;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              vm: {
                project: instance.project,
                zone: instance.zone,
                instanceName: instance.instanceName,
              },
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        vm = out.vm;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 900_000 });

    // Describes run in declaration order: Get, then Stop, then Start.
    describe("GetInstance", () => {
      test.provider(
        "reads the instance as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{
              name?: string;
              id?: string;
              status?: string;
            }>(baseUrl, "getInstance");
            const expected = yield* compute.getInstances({
              project: vm.project,
              zone: vm.zone,
              instance: vm.instanceName,
            });
            expect(live.name).toEqual(vm.instanceName);
            expect(live.id).toEqual(expected.id);
            expect(live.status).toEqual(expected.status);
            yield* expectInstanceGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:compute", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("StopInstance", () => {
      test.provider(
        "stops the instance as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            yield* waitForStatus("RUNNING");
            const op = yield* expectProbe<{
              operationType?: string;
              targetLink?: string;
            }>(baseUrl, "stopInstance");
            expect(op.operationType).toEqual("stop");
            expect(op.targetLink).toContain(`/instances/${vm.instanceName}`);
            expect(yield* waitForStatus("TERMINATED")).toEqual("TERMINATED");
            const seen = yield* expectProbe<{ status?: string }>(
              baseUrl,
              "getInstance",
            );
            expect(seen.status).toEqual("TERMINATED");
            yield* expectInstanceGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:compute", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("StartInstance", () => {
      test.provider(
        "starts the instance as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const op = yield* expectProbe<{
              operationType?: string;
              targetLink?: string;
            }>(baseUrl, "startInstance");
            expect(op.operationType).toEqual("start");
            expect(op.targetLink).toContain(`/instances/${vm.instanceName}`);
            expect(yield* waitForStatus("RUNNING")).toEqual("RUNNING");
            const seen = yield* expectProbe<{ status?: string }>(
              baseUrl,
              "getInstance",
            );
            expect(seen.status).toEqual("RUNNING");
            yield* expectInstanceGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:compute", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
