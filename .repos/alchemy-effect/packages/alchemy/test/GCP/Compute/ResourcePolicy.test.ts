import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (
  project: string,
  region: string,
  resourcePolicy: string,
) =>
  compute.getResourcePolicies({ project, region, resourcePolicy }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a resource policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.ResourcePolicy("Nightly", {
            region: "us-central1",
            description: "nightly snapshots",
            snapshotSchedulePolicy: {
              schedule: {
                dailySchedule: { daysInCycle: 1, startTime: "04:00" },
              },
              retentionPolicy: { maxRetentionDays: 7 },
            },
          });
        }),
      );

      expect(created.resourcePolicyName).toEqual(expect.any(String));
      expect(created.region).toEqual("us-central1");
      expect(created.status).toEqual("READY");
      expect(created.description).toEqual("nightly snapshots");
      expect(
        created.snapshotSchedulePolicy?.schedule?.dailySchedule?.startTime,
      ).toEqual("04:00");
      expect(
        created.snapshotSchedulePolicy?.retentionPolicy?.maxRetentionDays,
      ).toEqual(7);

      const fetched = yield* compute.getResourcePolicies({
        project: created.project,
        region: created.region,
        resourcePolicy: created.resourcePolicyName,
      });
      expect(fetched.name).toEqual(created.resourcePolicyName);
      expect(fetched.status).toEqual("READY");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("nightly snapshots");
      expect(
        fetched.snapshotSchedulePolicy?.schedule?.dailySchedule?.daysInCycle,
      ).toEqual(1);
      expect(
        fetched.snapshotSchedulePolicy?.retentionPolicy?.maxRetentionDays,
      ).toEqual(7);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.ResourcePolicy("Nightly", {
            resourcePolicyName: created.resourcePolicyName,
            region: "us-central1",
            description: "daily snapshots",
            snapshotSchedulePolicy: {
              schedule: {
                dailySchedule: { daysInCycle: 1, startTime: "08:00" },
              },
              retentionPolicy: { maxRetentionDays: 14 },
            },
          });
        }),
      );

      expect(updated.resourcePolicyName).toEqual(created.resourcePolicyName);
      expect(updated.description).toEqual("daily snapshots");
      expect(
        updated.snapshotSchedulePolicy?.schedule?.dailySchedule?.startTime,
      ).toEqual("08:00");
      expect(
        updated.snapshotSchedulePolicy?.retentionPolicy?.maxRetentionDays,
      ).toEqual(14);

      const fetchedUpdated = yield* compute.getResourcePolicies({
        project: updated.project,
        region: updated.region,
        resourcePolicy: updated.resourcePolicyName,
      });
      expect(fetchedUpdated.description).toContain("daily snapshots");
      expect(
        fetchedUpdated.snapshotSchedulePolicy?.schedule?.dailySchedule
          ?.startTime,
      ).toEqual("08:00");
      expect(
        fetchedUpdated.snapshotSchedulePolicy?.retentionPolicy
          ?.maxRetentionDays,
      ).toEqual(14);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.region,
        created.resourcePolicyName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
