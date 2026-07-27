import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import { AccessPoint } from "@/AWS/S3Control";
import * as Test from "@/Test/Alchemy";
import * as s3control from "@distilled.cloud/aws/s3-control";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const ACCOUNT_ID = "391965393224";

const findAccessPoint = (name: string) =>
  s3control
    .getAccessPoint({ AccountId: ACCOUNT_ID, Name: name })
    .pipe(
      Effect.catchTag("NoSuchAccessPoint", () => Effect.succeed(undefined)),
    );

class AccessPointStillExists extends Data.TaggedError(
  "AccessPointStillExists",
)<{ readonly name: string }> {}

const assertAccessPointDeleted = (name: string) =>
  findAccessPoint(name).pipe(
    Effect.flatMap((ap) =>
      ap === undefined
        ? Effect.void
        : Effect.fail(new AccessPointStillExists({ name })),
    ),
    Effect.retry({
      while: (e) => e._tag === "AccessPointStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "typed NoSuchAccessPoint tag on a nonexistent access point",
  () =>
    Effect.gen(function* () {
      const result = yield* s3control
        .getAccessPoint({
          AccountId: ACCOUNT_ID,
          Name: "alchemy-does-not-exist-xyz",
        })
        .pipe(
          Effect.map(() => "found" as const),
          // proves the patched typed union — no cast, no catch-all
          Effect.catchTag("NoSuchAccessPoint", () =>
            Effect.succeed("missing" as const),
          ),
        );
      expect(result).toBe("missing");
    }),
  { timeout: 60_000 },
);

test.provider(
  "create, update tags, delete access point",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("ApBucket", { forceDestroy: true });
          const accessPoint = yield* AccessPoint("TestAp", {
            bucket: bucket.bucketName,
            tags: { Environment: "test" },
          });
          return { bucket, accessPoint };
        }),
      );

      expect(deployed.accessPoint.accessPointName).toBeDefined();
      expect(deployed.accessPoint.accessPointArn).toContain(":accesspoint/");
      expect(deployed.accessPoint.networkOrigin).toBe("Internet");
      expect(deployed.accessPoint.bucket).toBe(deployed.bucket.bucketName);

      // out-of-band verification via distilled
      const live = yield* findAccessPoint(deployed.accessPoint.accessPointName);
      expect(live?.Bucket).toBe(deployed.bucket.bucketName);
      // AWS defaults every public-access-block flag to true
      expect(live?.PublicAccessBlockConfiguration?.BlockPublicAcls).toBe(true);

      const tags = yield* s3control
        .listTagsForResource({
          AccountId: ACCOUNT_ID,
          ResourceArn: deployed.accessPoint.accessPointArn,
        })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestAp");

      // update tags only — same access point, no replacement
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("ApBucket", { forceDestroy: true });
          const accessPoint = yield* AccessPoint("TestAp", {
            bucket: bucket.bucketName,
            tags: { Environment: "production", Team: "data" },
          });
          return { bucket, accessPoint };
        }),
      );
      expect(updated.accessPoint.accessPointName).toBe(
        deployed.accessPoint.accessPointName,
      );

      const updatedTags = yield* s3control
        .listTagsForResource({
          AccountId: ACCOUNT_ID,
          ResourceArn: updated.accessPoint.accessPointArn,
        })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(updatedTags.Environment).toBe("production");
      expect(updatedTags.Team).toBe("data");

      yield* stack.destroy();
      yield* assertAccessPointDeleted(deployed.accessPoint.accessPointName);
    }),
  // Generous wall: deploys serialize on the per-profile lock across suites.
  { timeout: 300_000 },
);

test.provider(
  "changing public-access-block replaces the access point",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("ReplBucket", { forceDestroy: true });
          const accessPoint = yield* AccessPoint("ReplAp", {
            bucket: bucket.bucketName,
          });
          return { bucket, accessPoint };
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("ReplBucket", { forceDestroy: true });
          const accessPoint = yield* AccessPoint("ReplAp", {
            bucket: bucket.bucketName,
            publicAccessBlock: {
              blockPublicAcls: true,
              ignorePublicAcls: true,
              blockPublicPolicy: false,
              restrictPublicBuckets: false,
            },
          });
          return { bucket, accessPoint };
        }),
      );

      // replacement: new physical name, old access point cleaned up
      expect(second.accessPoint.accessPointName).not.toBe(
        first.accessPoint.accessPointName,
      );
      const live = yield* findAccessPoint(second.accessPoint.accessPointName);
      expect(live?.PublicAccessBlockConfiguration?.BlockPublicPolicy).toBe(
        false,
      );
      yield* assertAccessPointDeleted(first.accessPoint.accessPointName);

      yield* stack.destroy();
      yield* assertAccessPointDeleted(second.accessPoint.accessPointName);
    }),
  // Individual steps are fast (<3s solo), but deploys serialize on the
  // per-profile lock across every concurrently-running suite, so the
  // last-scheduled test in a busy run can queue for minutes.
  { timeout: 300_000 },
);
