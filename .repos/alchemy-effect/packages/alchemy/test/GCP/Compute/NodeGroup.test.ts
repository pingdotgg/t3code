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

// A sole-tenant node bills for the whole host (several dollars per hour).
// Set GCP_TEST_COMPUTE_NODE=1 to opt in.
const runLifecycle = !!process.env.GCP_TEST_COMPUTE_NODE && !process.env.FAST;

const zone = "us-central1-a";
const region = "us-central1";

const waitUntilGone = (nodeGroup: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getNodeGroups({ project, zone, nodeGroup }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (status) => status === "gone",
          times: 10,
        }),
      ),
    ),
  );

test.provider(
  "getNodeGroups on a missing group fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getNodeGroups({
          project,
          zone,
          nodeGroup: "alchemy-missing-ng",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider(
  "insertNodeGroups with a malformed node template fails with BadRequest",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        compute.insertNodeGroups({
          project,
          zone,
          initialNodeCount: 0,
          body: {
            name: "alchemy-ng-probe",
            description: "alchemy entitlement probe",
            nodeTemplate: "does-not-exist",
          },
        }),
      );
      expect(error._tag).toEqual("BadRequest");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a node group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.NodeTemplate("SoleTenant", {
            region,
            nodeType: "n2-node-80-640",
            description: "prod sole tenant",
          });
          const group = yield* GCP.Compute.NodeGroup("SoleTenant", {
            zone,
            nodeTemplate: template.nodeTemplateName,
            initialNodeCount: 0,
            description: "prod sole tenant",
          });
          return { template, group };
        }),
      );

      expect(created.group.nodeGroupName).toEqual(expect.any(String));
      expect(created.group.zone).toEqual(zone);
      expect(created.group.description).toEqual("prod sole tenant");

      const fetched = yield* compute.getNodeGroups({
        project: created.group.project,
        zone,
        nodeGroup: created.group.nodeGroupName,
      });
      expect(fetched.name).toEqual(created.group.nodeGroupName);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.NodeTemplate("SoleTenant", {
            nodeTemplateName: created.template.nodeTemplateName,
            region,
            nodeType: "n2-node-80-640",
            description: "prod sole tenant",
          });
          return yield* GCP.Compute.NodeGroup("SoleTenant", {
            nodeGroupName: created.group.nodeGroupName,
            zone,
            nodeTemplate: template.nodeTemplateName,
            initialNodeCount: 0,
            description: "updated sole tenant",
          });
        }),
      );
      expect(updated.description).toEqual("updated sole tenant");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.group.nodeGroupName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
