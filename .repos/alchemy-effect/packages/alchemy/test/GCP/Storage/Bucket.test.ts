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

const waitUntilGone = (bucketName: string) =>
  storage.getBuckets({ bucket: bucketName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Storage.Bucket("Assets", {
            location: "US-CENTRAL1",
            labels: { env: "test" },
            forceDestroy: true,
          });
        }),
      );

      expect(created.bucketName).toEqual(expect.any(String));
      expect(created.location.toUpperCase()).toEqual("US-CENTRAL1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.versioning).toEqual(false);

      const fetched = yield* storage.getBuckets({
        bucket: created.bucketName,
        projection: "full",
      });
      expect(fetched.name).toEqual(created.bucketName);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Storage.Bucket("Assets", {
            bucketName: created.bucketName,
            location: "US-CENTRAL1",
            storageClass: "NEARLINE",
            versioning: true,
            labels: { env: "prod", role: "assets" },
            forceDestroy: true,
          });
        }),
      );

      expect(updated.bucketName).toEqual(created.bucketName);
      expect(updated.versioning).toEqual(true);
      expect(updated.storageClass).toEqual("NEARLINE");
      expect(updated.labels).toMatchObject({ env: "prod", role: "assets" });

      const trimmed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Storage.Bucket("Assets", {
            bucketName: created.bucketName,
            location: "US-CENTRAL1",
            storageClass: "NEARLINE",
            versioning: true,
            labels: { env: "prod" },
            forceDestroy: true,
          });
        }),
      );

      expect(trimmed.labels).toMatchObject({ env: "prod" });
      expect(trimmed.labels.role).toBeUndefined();
      const fetchedTrimmed = yield* storage.getBuckets({
        bucket: trimmed.bucketName,
        projection: "full",
      });
      expect(fetchedTrimmed.labels?.role).toBeUndefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.bucketName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 120_000 },
);
