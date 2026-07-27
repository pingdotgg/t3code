import * as AWS from "@/AWS";
import { Snapshot, Volume } from "@/AWS/EC2";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const AZ = "us-west-2a";

test.provider(
  "snapshot a volume, wait for completion, then delete both",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { volume, snapshot } = yield* stack.deploy(
        Effect.gen(function* () {
          const volume = yield* Volume("SnapSourceVolume", {
            availabilityZone: AZ,
            size: 1,
            volumeType: "gp3",
          });
          const snapshot = yield* Snapshot("TestSnapshot", {
            volumeId: volume.volumeId,
            description: "alchemy storage-trio test snapshot",
          });
          return { volume, snapshot };
        }),
      );

      expect(snapshot.snapshotId).toMatch(/^snap-/);
      expect(snapshot.volumeId).toBe(volume.volumeId);
      // The provider waits for completion before returning.
      expect(snapshot.state).toBe("completed");

      // Out-of-band verification.
      const observed = yield* EC2.describeSnapshots({
        SnapshotIds: [snapshot.snapshotId],
      });
      const s = observed.Snapshots?.[0];
      expect(s?.State).toBe("completed");
      expect(s?.VolumeId).toBe(volume.volumeId);

      yield* stack.destroy();
      yield* assertSnapshotDeleted(snapshot.snapshotId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

const assertSnapshotDeleted = Effect.fn(function* (snapshotId: string) {
  yield* EC2.describeSnapshots({ SnapshotIds: [snapshotId] }).pipe(
    Effect.flatMap(() => Effect.fail(new SnapshotStillExists())),
    Effect.retry({
      while: (e) => e instanceof SnapshotStillExists,
      schedule: Schedule.max([Schedule.exponential(200), Schedule.recurs(8)]),
    }),
    Effect.catchTag("InvalidSnapshot.NotFound", () => Effect.void),
  );
});

class SnapshotStillExists extends Data.TaggedError("SnapshotStillExists") {}
