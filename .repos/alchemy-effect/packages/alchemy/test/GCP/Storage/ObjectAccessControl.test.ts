import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const ENTITY = "user-alchemy-gcp-testing-83661@appspot.gserviceaccount.com";
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
        HttpClientRequest.setHeader(
          "Authorization",
          `Bearer ${Redacted.value(creds.accessToken)}`,
        ),
        HttpClientRequest.bodyUint8Array(bytes, "text/plain"),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      return yield* Effect.fail(
        new Error(`object upload failed: ${response.status} ${text}`),
      );
    }
  });

test.provider(
  "create, update, and delete an object ACL",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

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
            entity: ENTITY,
            role: "READER",
          });
        }),
      );

      expect(created.bucketName).toEqual(bucket.bucketName);
      expect(created.object).toEqual(OBJECT_NAME);
      expect(created.entity).toEqual(ENTITY);
      expect(created.role).toEqual("READER");

      const fetched = yield* storage.getObjectAccessControls({
        bucket: created.bucketName,
        object: OBJECT_NAME,
        entity: ENTITY,
      });
      expect(fetched.entity).toEqual(ENTITY);
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
            entity: ENTITY,
            role: "OWNER",
          });
        }),
      );

      expect(updated.bucketName).toEqual(created.bucketName);
      expect(updated.entity).toEqual(ENTITY);
      expect(updated.role).toEqual("OWNER");

      const refetched = yield* storage.getObjectAccessControls({
        bucket: updated.bucketName,
        object: OBJECT_NAME,
        entity: ENTITY,
      });
      expect(refetched.role).toEqual("OWNER");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.bucketName,
        OBJECT_NAME,
        ENTITY,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 90_000 },
);
