import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// The testing profile's own service account, derived from the configured project.
const serviceAccountEmailOf = GcpEnvironment.current.pipe(
  Effect.map(({ project }) => `alchemy-testing@${project}.iam.gserviceaccount.com`),
);

const waitUntilGone = (bucketName: string, entity: string) =>
  storage.getDefaultObjectAccessControls({ bucket: bucketName, entity }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a default object ACL",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const entity = `user-${yield* serviceAccountEmailOf}`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Assets", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.Storage.DefaultObjectAccessControl("Reader", {
            bucketName: bucket.bucketName,
            entity: entity,
            role: "READER",
          });
        }),
      );

      expect(created.bucketName).toEqual(expect.any(String));
      expect(created.entity).toEqual(entity);
      expect(created.role).toEqual("READER");

      const fetched = yield* storage.getDefaultObjectAccessControls({
        bucket: created.bucketName,
        entity: entity,
      });
      expect(fetched.entity).toEqual(entity);
      expect(fetched.role).toEqual("READER");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Assets", {
            bucketName: created.bucketName,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.Storage.DefaultObjectAccessControl("Reader", {
            bucketName: bucket.bucketName,
            entity: entity,
            role: "OWNER",
          });
        }),
      );

      expect(updated.bucketName).toEqual(created.bucketName);
      expect(updated.entity).toEqual(entity);
      expect(updated.role).toEqual("OWNER");

      const refetched = yield* storage.getDefaultObjectAccessControls({
        bucket: updated.bucketName,
        entity: entity,
      });
      expect(refetched.role).toEqual("OWNER");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.bucketName, entity);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 90_000 },
);
