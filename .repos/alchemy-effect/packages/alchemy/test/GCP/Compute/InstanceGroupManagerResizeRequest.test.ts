import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Resize requests only accept accelerator (GPU) templates — a CPU template
// fails with `Resize requests without accelerators are not supported.` GPUs
// need quota and cost real money, so set GCP_TEST_MIG_RESIZE_REQUEST=1 (with
// GPU quota) to opt in.
const runLifecycle =
  !!process.env.GCP_TEST_MIG_RESIZE_REQUEST && !process.env.FAST;

const zone = "us-central1-a";

const templateProps: GCP.Compute.InstanceTemplateProps = {
  machineType: "e2-micro",
  disks: [
    {
      boot: true,
      autoDelete: true,
      sourceImage: "projects/debian-cloud/global/images/family/debian-12",
      diskSizeGb: 10,
    },
  ],
  networkInterfaces: [{ network: "global/networks/default" }],
};

const waitUntilGone = (
  project: string,
  zoneName: string,
  instanceGroupManager: string,
  resizeRequest: string,
) =>
  compute
    .getInstanceGroupManagerResizeRequests({
      project,
      zone: zoneName,
      instanceGroupManager,
      resizeRequest,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "insertInstanceGroupManagerResizeRequests on a missing manager fails with NotFound",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        compute.insertInstanceGroupManagerResizeRequests({
          project,
          zone,
          instanceGroupManager: "does-not-exist",
          body: {
            name: "alchemy-rr-probe",
            description: "alchemy entitlement probe",
            resizeBy: 1,
          },
        }),
      );
      expect(error._tag).toEqual("NotFound");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete an instance group manager resize request",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.InstanceTemplate("Template", {
            ...templateProps,
          });
          const manager = yield* GCP.Compute.InstanceGroupManager("Manager", {
            zone,
            instanceTemplate: template.templateName,
            targetSize: 0,
            // Resize requests are rejected while automatic repair is on.
            instanceLifecyclePolicy: { defaultActionOnFailure: "DO_NOTHING" },
          });
          const request = yield* GCP.Compute.InstanceGroupManagerResizeRequest(
            "Burst",
            {
              zone,
              instanceGroupManager: manager.managerName,
              resizeBy: 1,
              requestedRunDuration: { seconds: "600" },
              description: "queued burst",
            },
          );
          return { template, manager, request };
        }),
      );

      expect(created.request.resizeRequestName).toEqual(expect.any(String));
      expect(created.request.resizeBy).toEqual(1);
      expect(created.request.description).toEqual("queued burst");
      expect(created.request.instanceGroupManager).toEqual(
        created.manager.managerName,
      );

      const fetched = yield* compute.getInstanceGroupManagerResizeRequests({
        project: created.request.project,
        zone,
        instanceGroupManager: created.manager.managerName,
        resizeRequest: created.request.resizeRequestName,
      });
      expect(fetched.name).toEqual(created.request.resizeRequestName);
      expect(fetched.description).toContain("[alchemy ");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.request.project,
        zone,
        created.manager.managerName,
        created.request.resizeRequestName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
