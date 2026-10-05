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

const SERVICE_ACCOUNT_EMAIL =
  "alchemy-testing@alchemy-gcp-testing-83661.iam.gserviceaccount.com";
const ENTITY = `user-${SERVICE_ACCOUNT_EMAIL}`;

const waitUntilGone = (bucketName: string, entity: string) =>
  storage.getBucketAccessControls({ bucket: bucketName, entity }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a bucket ACL",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Assets", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.Storage.BucketAccessControl("Writer", {
            bucketName: bucket.bucketName,
            entity: ENTITY,
            role: "READER",
          });
        }),
      );

      expect(created.bucketName).toEqual(expect.any(String));
      expect(created.entity).toEqual(ENTITY);
      expect(created.role).toEqual("READER");

      const fetched = yield* storage.getBucketAccessControls({
        bucket: created.bucketName,
        entity: ENTITY,
      });
      expect(fetched.entity).toEqual(ENTITY);
      expect(fetched.role).toEqual("READER");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Assets", {
            bucketName: created.bucketName,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.Storage.BucketAccessControl("Writer", {
            bucketName: bucket.bucketName,
            entity: ENTITY,
            role: "WRITER",
          });
        }),
      );

      expect(updated.bucketName).toEqual(created.bucketName);
      expect(updated.entity).toEqual(ENTITY);
      expect(updated.role).toEqual("WRITER");

      const refetched = yield* storage.getBucketAccessControls({
        bucket: updated.bucketName,
        entity: ENTITY,
      });
      expect(refetched.role).toEqual("WRITER");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.bucketName, ENTITY);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 90_000 },
);
