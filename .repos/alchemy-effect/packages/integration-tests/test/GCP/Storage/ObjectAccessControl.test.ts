import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// The project's App Engine default service account: a stable principal that
// is not the uploading (testing) identity, which already holds its own OWNER
// entry on the object.
const granteeEntityOf = GcpEnvironment.current.pipe(
  Effect.map(({ project }) => `user-${project}@appspot.gserviceaccount.com`),
);
const OBJECT_NAME = "hello.txt";

const waitUntilGone = (bucketName: string, object: string, entity: string) =>
  storage.getObjectAccessControls({ bucket: bucketName, object, entity }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const uploadObject = (bucketName: string, object: string, body: string) =>
  Effect.gen(function* () {
    const creds = yield* yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const bytes = yield* Effect.sync(() => new TextEncoder().encode(body));
    const url =
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucketName)}/o` +
      `?uploadType=media&name=${encodeURIComponent(object)}`;
    const response = yield* client.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(creds.accessToken)}`),
        HttpClientRequest.bodyUint8Array(bytes, "text/plain"),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
      return yield* Effect.fail(new Error(`object upload failed: ${response.status} ${text}`));
    }
  });

test.provider(
  "create, update, and delete an object ACL",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const entity = yield* granteeEntityOf;

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Storage.Bucket("Assets", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
        }),
      );

      yield* uploadObject(bucket.bucketName, OBJECT_NAME, "hello");

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const next = yield* GCP.Storage.Bucket("Assets", {
            bucketName: bucket.bucketName,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.Storage.ObjectAccessControl("Reader", {
            bucketName: next.bucketName,
            object: OBJECT_NAME,
            entity,
            role: "READER",
          });
        }),
      );

      expect(created.bucketName).toEqual(bucket.bucketName);
      expect(created.object).toEqual(OBJECT_NAME);
      expect(created.entity).toEqual(entity);
      expect(created.role).toEqual("READER");

      const fetched = yield* storage.getObjectAccessControls({
        bucket: created.bucketName,
        object: OBJECT_NAME,
        entity,
      });
      expect(fetched.entity).toEqual(entity);
      expect(fetched.role).toEqual("READER");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const next = yield* GCP.Storage.Bucket("Assets", {
            bucketName: created.bucketName,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.Storage.ObjectAccessControl("Reader", {
            bucketName: next.bucketName,
            object: OBJECT_NAME,
            entity,
            role: "OWNER",
          });
        }),
      );

      expect(updated.bucketName).toEqual(created.bucketName);
      expect(updated.entity).toEqual(entity);
      expect(updated.role).toEqual("OWNER");

      const refetched = yield* storage.getObjectAccessControls({
        bucket: updated.bucketName,
        object: OBJECT_NAME,
        entity,
      });
      expect(refetched.role).toEqual("OWNER");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.bucketName, OBJECT_NAME, entity);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 90_000 },
);
