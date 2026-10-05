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

const zone = "us-central1-a";

const waitUntilGone = (
  projectId: string,
  policyZone: string,
  vmExtensionPolicy: string,
) =>
  compute
    .getZoneVmExtensionPolicies({
      project: projectId,
      zone: policyZone,
      vmExtensionPolicy,
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
  "getZoneVmExtensionPolicies on a missing policy fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getZoneVmExtensionPolicies({
          project,
          zone,
          vmExtensionPolicy: "alchemy-missing-vm-extension-policy",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a zone VM extension policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.ZoneVmExtensionPolicy("Ops", {
            zone,
            description: "ops-agent for test vms",
            priority: 500,
            extensionPolicies: { "ops-agent": {} },
            instanceSelectors: [
              {
                labelSelector: {
                  inclusionLabels: { "alchemy-vm-extension": "never" },
                },
              },
            ],
          });
        }),
      );

      expect(created.vmExtensionPolicyName).toEqual(expect.any(String));
      expect(created.zone).toEqual(zone);
      expect(created.description).toEqual("ops-agent for test vms");
      expect(created.priority).toEqual(500);
      expect(created.extensionPolicies?.["ops-agent"]).toBeDefined();

      const fetched = yield* compute.getZoneVmExtensionPolicies({
        project: created.project,
        zone: created.zone,
        vmExtensionPolicy: created.vmExtensionPolicyName,
      });
      expect(fetched.name).toEqual(created.vmExtensionPolicyName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("ops-agent for test vms");
      expect(fetched.priority).toEqual(500);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.ZoneVmExtensionPolicy("Ops", {
            vmExtensionPolicyName: created.vmExtensionPolicyName,
            zone,
            description: "ops-agent for labeled vms",
            priority: 400,
            extensionPolicies: { "ops-agent": { pinnedVersion: "2.58.0" } },
            instanceSelectors: [
              {
                labelSelector: {
                  inclusionLabels: { "alchemy-vm-extension": "never" },
                },
              },
            ],
          });
        }),
      );

      expect(updated.vmExtensionPolicyName).toEqual(
        created.vmExtensionPolicyName,
      );
      expect(updated.description).toEqual("ops-agent for labeled vms");
      expect(updated.priority).toEqual(400);
      expect(updated.extensionPolicies?.["ops-agent"]?.pinnedVersion).toEqual(
        "2.58.0",
      );

      const fetchedUpdated = yield* compute.getZoneVmExtensionPolicies({
        project: updated.project,
        zone: updated.zone,
        vmExtensionPolicy: updated.vmExtensionPolicyName,
      });
      expect(fetchedUpdated.description).toContain("ops-agent for labeled vms");
      expect(fetchedUpdated.priority).toEqual(400);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.project,
        created.zone,
        created.vmExtensionPolicyName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
