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

const region = "us-central1";

const waitUntilGone = (project: string, instantSnapshotGroup: string) =>
  compute
    .getRegionInstantSnapshotGroups({
      project,
      region,
      instantSnapshotGroup,
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
  "insertRegionInstantSnapshotGroups with a malformed consistency group fails with BadRequest",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        compute.insertRegionInstantSnapshotGroups({
          project,
          region,
          sourceConsistencyGroup: "does-not-exist",
          body: {
            name: "alchemy-risg-probe",
            description: "alchemy entitlement probe",
            sourceConsistencyGroup: "does-not-exist",
          },
        }),
      );
      expect(error._tag).toEqual("BadRequest");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 60_000 },
);

test.provider(
  "create and delete a regional instant snapshot group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.Compute.ResourcePolicy("Consistent", {
            region,
            diskConsistencyGroupPolicy: {},
          });
          const disk = yield* GCP.Compute.RegionDisk("Member", {
            region,
            replicaZones: ["us-central1-a", "us-central1-b"],
            type: "hyperdisk-balanced-high-availability",
            sizeGb: 4,
          });
          return { policy, disk };
        }),
      );

      yield* compute.addResourcePoliciesRegionDisks({
        project: created.disk.project,
        region,
        disk: created.disk.diskName,
        body: {
          resourcePolicies: [
            created.policy.selfLink ??
              `projects/${created.disk.project}/regions/${region}/resourcePolicies/${created.policy.resourcePolicyName}`,
          ],
        },
      });

      const withGroup = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.Compute.ResourcePolicy("Consistent", {
            resourcePolicyName: created.policy.resourcePolicyName,
            region,
            diskConsistencyGroupPolicy: {},
          });
          const disk = yield* GCP.Compute.RegionDisk("Member", {
            diskName: created.disk.diskName,
            region,
            replicaZones: ["us-central1-a", "us-central1-b"],
            type: "hyperdisk-balanced-high-availability",
            sizeGb: 4,
          });
          const group = yield* GCP.Compute.RegionInstantSnapshotGroup(
            "Checkpoint",
            {
              region,
              sourceConsistencyGroup: policy.selfLink.as<string>(),
              description: "group checkpoint",
            },
          );
          return { policy, disk, group };
        }),
      );

      expect(withGroup.group.instantSnapshotGroupName).toEqual(
        expect.any(String),
      );
      expect(withGroup.group.region).toEqual(region);
      expect(withGroup.group.description).toEqual("group checkpoint");

      const fetched = yield* compute.getRegionInstantSnapshotGroups({
        project: withGroup.group.project,
        region,
        instantSnapshotGroup: withGroup.group.instantSnapshotGroupName,
      });
      expect(fetched.name).toEqual(withGroup.group.instantSnapshotGroupName);
      expect(fetched.description).toContain("[alchemy ");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        withGroup.group.project,
        withGroup.group.instantSnapshotGroupName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
