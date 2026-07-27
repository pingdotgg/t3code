import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as efs from "@distilled.cloud/aws/efs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const efsTagsToRecord = (
  tags: readonly efs.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value]));

// Typed wait-until-gone for an access point.
const waitUntilAccessPointGone = (accessPointId: string) =>
  efs.describeAccessPoints({ AccessPointId: accessPointId }).pipe(
    Effect.map((r) =>
      (r.AccessPoints ?? []).every((ap) => ap.LifeCycleState === "deleted"),
    ),
    Effect.catchTag("AccessPointNotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.fixed("2 seconds"),
      until: (gone) => gone,
      times: 30,
    }),
  );

test.provider(
  "create, update tags, replace, delete access point",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const infra = (posixUid: number, tag: string) =>
        Effect.gen(function* () {
          const files = yield* AWS.EFS.FileSystem("ApFiles");
          const accessPoint = yield* AWS.EFS.AccessPoint("ApAccess", {
            fileSystemId: files.fileSystemId,
            posixUser: { uid: posixUid, gid: 1000 },
            rootDirectory: {
              path: "/app",
              creationInfo: {
                ownerUid: posixUid,
                ownerGid: 1000,
                permissions: "750",
              },
            },
            tags: { purpose: tag },
          });
          return { files, accessPoint };
        });

      // --- create ---
      const created = yield* stack.deploy(infra(1000, "alchemy-efs-ap-test"));
      expect(created.accessPoint.accessPointId).toMatch(/^fsap-/);
      expect(created.accessPoint.accessPointArn).toContain(":access-point/");
      expect(created.accessPoint.fileSystemId).toBe(created.files.fileSystemId);

      const observed = yield* efs
        .describeAccessPoints({
          AccessPointId: created.accessPoint.accessPointId,
        })
        .pipe(Effect.map((r) => r.AccessPoints![0]));
      expect(observed.LifeCycleState).toBe("available");
      expect(observed.PosixUser?.Uid).toBe(1000);
      expect(observed.RootDirectory?.Path).toBe("/app");
      const observedTags = efsTagsToRecord(observed.Tags);
      expect(observedTags.purpose).toBe("alchemy-efs-ap-test");
      expect(observedTags["alchemy::id"]).toBe("ApAccess");

      // --- update tags in place ---
      const retagged = yield* stack.deploy(infra(1000, "alchemy-efs-ap-retag"));
      expect(retagged.accessPoint.accessPointId).toBe(
        created.accessPoint.accessPointId,
      );
      const retaggedObserved = yield* efs
        .describeAccessPoints({
          AccessPointId: created.accessPoint.accessPointId,
        })
        .pipe(Effect.map((r) => efsTagsToRecord(r.AccessPoints![0].Tags)));
      expect(retaggedObserved.purpose).toBe("alchemy-efs-ap-retag");

      // --- posixUser change replaces the access point ---
      const replaced = yield* stack.deploy(infra(1001, "alchemy-efs-ap-retag"));
      expect(replaced.accessPoint.accessPointId).not.toBe(
        created.accessPoint.accessPointId,
      );
      const replacedObserved = yield* efs
        .describeAccessPoints({
          AccessPointId: replaced.accessPoint.accessPointId,
        })
        .pipe(Effect.map((r) => r.AccessPoints![0]));
      expect(replacedObserved.PosixUser?.Uid).toBe(1001);
      const oldGone = yield* waitUntilAccessPointGone(
        created.accessPoint.accessPointId,
      );
      expect(oldGone).toBe(true);

      // --- destroy: access point and file system both gone ---
      yield* stack.destroy();
      const apGone = yield* waitUntilAccessPointGone(
        replaced.accessPoint.accessPointId,
      );
      expect(apGone).toBe(true);
      const fsGone = yield* efs
        .describeFileSystems({ FileSystemId: created.files.fileSystemId })
        .pipe(
          Effect.map((r) =>
            (r.FileSystems ?? []).every((f) => f.LifeCycleState === "deleted"),
          ),
          Effect.catchTag("FileSystemNotFound", () => Effect.succeed(true)),
          Effect.repeat({
            schedule: Schedule.fixed("2 seconds"),
            until: (gone) => gone,
            times: 30,
          }),
        );
      expect(fsGone).toBe(true);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 120_000 },
);
