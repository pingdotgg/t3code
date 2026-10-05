import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (bucketName: string, managedFolderName: string) =>
  storage
    .getManagedFolders({
      bucket: bucketName,
      managedFolder: managedFolderName,
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
  "create, replace, and delete a managed folder",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Assets", {
            location: "US-CENTRAL1",
            uniformBucketLevelAccess: true,
            forceDestroy: true,
          });
          const folder = yield* GCP.Storage.Managed("Team", {
            bucketName: bucket.bucketName,
            managedFolderName: "teams/",
          });
          return { bucket, folder };
        }),
      );

      expect(created.folder.bucketName).toEqual(created.bucket.bucketName);
      expect(created.folder.managedFolderName).toEqual("teams/");
      expect(created.bucket.uniformBucketLevelAccess).toEqual(true);

      const fetched = yield* storage.getManagedFolders({
        bucket: created.folder.bucketName,
        managedFolder: created.folder.managedFolderName,
      });
      expect(fetched.name).toEqual("teams/");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Assets", {
            bucketName: created.bucket.bucketName,
            location: "US-CENTRAL1",
            uniformBucketLevelAccess: true,
            forceDestroy: true,
          });
          const folder = yield* GCP.Storage.Managed("Team", {
            bucketName: bucket.bucketName,
            managedFolderName: "payments/",
          });
          return { bucket, folder };
        }),
      );

      expect(updated.folder.bucketName).toEqual(created.bucket.bucketName);
      expect(updated.folder.managedFolderName).toEqual("payments/");
      expect(updated.folder.managedFolderName).not.toEqual(
        created.folder.managedFolderName,
      );

      const refetched = yield* storage.getManagedFolders({
        bucket: updated.folder.bucketName,
        managedFolder: updated.folder.managedFolderName,
      });
      expect(refetched.name).toEqual("payments/");

      const previousGone = yield* waitUntilGone(
        created.folder.bucketName,
        created.folder.managedFolderName,
      );
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        updated.folder.bucketName,
        updated.folder.managedFolderName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 90_000 },
);
