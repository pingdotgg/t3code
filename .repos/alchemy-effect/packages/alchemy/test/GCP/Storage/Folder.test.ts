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

const waitUntilGone = (bucketName: string, folderName: string) =>
  storage.getFolders({ bucket: bucketName, folder: folderName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, replace, and delete a folder",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Tree", {
            location: "US-CENTRAL1",
            hierarchicalNamespace: true,
            uniformBucketLevelAccess: true,
            forceDestroy: true,
          });
          const folder = yield* GCP.Storage.Folder("Uploads", {
            bucketName: bucket.bucketName,
            folderName: "uploads/",
          });
          return { bucket, folder };
        }),
      );

      expect(created.folder.bucketName).toEqual(created.bucket.bucketName);
      expect(created.folder.folderName).toEqual("uploads/");
      expect(created.bucket.hierarchicalNamespace).toEqual(true);

      const fetched = yield* storage.getFolders({
        bucket: created.folder.bucketName,
        folder: created.folder.folderName,
      });
      expect(fetched.name).toEqual("uploads/");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Tree", {
            bucketName: created.bucket.bucketName,
            location: "US-CENTRAL1",
            hierarchicalNamespace: true,
            uniformBucketLevelAccess: true,
            forceDestroy: true,
          });
          const folder = yield* GCP.Storage.Folder("Uploads", {
            bucketName: bucket.bucketName,
            folderName: "incoming/",
          });
          return { bucket, folder };
        }),
      );

      expect(updated.folder.bucketName).toEqual(created.bucket.bucketName);
      expect(updated.folder.folderName).toEqual("incoming/");
      expect(updated.folder.folderName).not.toEqual(created.folder.folderName);

      const refetched = yield* storage.getFolders({
        bucket: updated.folder.bucketName,
        folder: updated.folder.folderName,
      });
      expect(refetched.name).toEqual("incoming/");

      const previousGone = yield* waitUntilGone(
        created.folder.bucketName,
        created.folder.folderName,
      );
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        updated.folder.bucketName,
        updated.folder.folderName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 90_000 },
);
