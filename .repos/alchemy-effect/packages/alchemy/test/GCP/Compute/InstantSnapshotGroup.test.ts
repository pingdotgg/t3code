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
  project: string,
  zoneName: string,
  instantSnapshotGroup: string,
) =>
  compute
    .getInstantSnapshotGroups({
      project,
      zone: zoneName,
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
  "insertInstantSnapshotGroups with a malformed consistency group fails with BadRequest",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        compute.insertInstantSnapshotGroups({
          project,
          zone,
          sourceConsistencyGroup: "does-not-exist",
          body: {
            name: "alchemy-isg-probe",
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
  "create and delete an instant snapshot group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.Compute.ResourcePolicy("Consistent", {
            region: "us-central1",
            diskConsistencyGroupPolicy: {},
          });
          const disk = yield* GCP.Compute.Disk("Member", {
            zone,
            type: "hyperdisk-balanced",
            sizeGb: 4,
          });
          return { policy, disk };
        }),
      );

      yield* compute.addResourcePoliciesDisks({
        project: created.disk.project,
        zone,
        disk: created.disk.diskName,
        body: {
          resourcePolicies: [
            created.policy.selfLink ??
              `projects/${created.disk.project}/regions/us-central1/resourcePolicies/${created.policy.resourcePolicyName}`,
          ],
        },
      });

      const withGroup = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.Compute.ResourcePolicy("Consistent", {
            resourcePolicyName: created.policy.resourcePolicyName,
            region: "us-central1",
            diskConsistencyGroupPolicy: {},
          });
          const disk = yield* GCP.Compute.Disk("Member", {
            diskName: created.disk.diskName,
            zone,
            type: "hyperdisk-balanced",
            sizeGb: 4,
          });
          const group = yield* GCP.Compute.InstantSnapshotGroup("Checkpoint", {
            zone,
            sourceConsistencyGroup: policy.selfLink.as<string>(),
            description: "group checkpoint",
          });
          return { policy, disk, group };
        }),
      );

      expect(withGroup.group.instantSnapshotGroupName).toEqual(
        expect.any(String),
      );
      expect(withGroup.group.zone).toEqual(zone);
      expect(withGroup.group.description).toEqual("group checkpoint");

      const fetched = yield* compute.getInstantSnapshotGroups({
        project: withGroup.group.project,
        zone,
        instantSnapshotGroup: withGroup.group.instantSnapshotGroupName,
      });
      expect(fetched.name).toEqual(withGroup.group.instantSnapshotGroupName);
      expect(fetched.description).toContain("[alchemy ");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        withGroup.group.project,
        zone,
        withGroup.group.instantSnapshotGroupName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
