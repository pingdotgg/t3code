import { providers } from "@/Neon/Providers";
import { Function as NeonFunction } from "@/Neon/Function";
import { bucketStorageClient } from "@/Neon/Bucket";
import * as Redacted from "effect/Redacted";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import StorageFunction from "./fixtures/StorageFunction.ts";
import { StorageBucket, StorageSettings } from "./fixtures/StorageResources.ts";

const { test } = Test.make({ providers: providers() });

test.provider(
  "injected Function credentials preserve typed object DX without extra customer credentials",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { fn, bucket } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* StorageBucket;
          yield* StorageSettings;
          const fn = yield* StorageFunction;
          return { fn, bucket };
        }),
      );
      const credentials = yield* SDK.listCredentials({
        project_id: bucket.projectId,
        branch_id: bucket.branchId,
      });
      expect(
        credentials.credentials
          .filter(
            (credential) =>
              credential.principal_type === "user" &&
              credential.branch_id === bucket.branchId &&
              !credential.revoked_at,
          )
          .map((credential) => credential.name),
      ).toHaveLength(1);
      const http = yield* HttpClient.HttpClient;
      const initial = yield* HttpClient.filterStatusOk(http)
        .get(fn.url)
        .pipe(
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
        );
      expect(initial.status).toBe(200);
      expect(yield* initial.json).toEqual({ theme: "system", pageSize: 25 });
      const upload = (yield* (yield* http.get(`${fn.url}/presign`)).json) as {
        url: string;
      };
      expect(
        (yield* http.put(upload.url, {
          body: HttpBody.text("effect presign", "text/plain"),
        })).status,
      ).toBe(200);
      const download = (yield* (yield* http.get(`${fn.url}/download`))
        .json) as { url: string };
      expect(yield* (yield* http.get(download.url)).text).toBe(
        "effect presign",
      );
      const written = yield* http.get(`${fn.url}/write`);
      if (written.status !== 200)
        yield* Effect.log("Storage write failed", {
          tag: written.headers["x-storage-error"] ?? "unclassified",
        });
      expect(written.status).toBe(200);
      yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => index),
        () =>
          Effect.gen(function* () {
            const repeated = yield* http.get(`${fn.url}/write`);
            if (repeated.status !== 200)
              yield* Effect.log("Storage write failed", {
                tag: repeated.headers["x-storage-error"] ?? "unclassified",
              });
            expect(repeated.status).toBe(200);
          }),
      );
      expect(yield* (yield* http.get(fn.url)).json).toEqual({
        theme: "dark",
        pageSize: 50,
      });
      expect(yield* (yield* http.get(`${fn.url}/invalid`)).text).toBe(
        "rejected",
      );
      const invalidRead = yield* http.get(fn.url);
      expect(invalidRead.status).toBe(500);
      expect(yield* invalidRead.text).toBe("Storage request failed");
      yield* stack.destroy();
      expect(
        yield* SDK.getProject({ project_id: bucket.projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:bucket",
      "provider:neon:function",
      "provider:neon:object",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "native injected S3 credentials support authenticated and presigned roundtrips",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { fn, bucket } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* StorageBucket;
          const fn = yield* NeonFunction("StorageNative", {
            branch: bucket.Props.branch!,
            main: (yield* Path.Path).join(
              import.meta.dirname,
              "fixtures",
              "StorageNative.ts",
            ),
            env: {
              BUCKET_NAME: bucket.bucketName,
              APP_TOKEN: Redacted.make("neon-storage-fixture-token"),
            },
          });
          return { fn, bucket };
        }),
      );
      const http = yield* HttpClient.HttpClient;
      const headers = { authorization: "Bearer neon-storage-fixture-token" };
      expect((yield* http.get(fn.url)).status).toBe(401);
      const presign = yield* HttpClient.filterStatusOk(http)
        .get(`${fn.url}/presign`, { headers })
        .pipe(
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
        );
      const { url } = (yield* presign.json) as { url: string };
      const upload = yield* http.put(url, {
        body: HttpBody.text("native roundtrip"),
      });
      expect(upload.status).toBe(200);
      const download = yield* http.get(fn.url, { headers });
      expect(yield* download.text).toBe("native roundtrip");
      expect(
        (yield* (yield* bucketStorageClient(bucket)).head("native.txt"))
          ?.ContentLength,
      ).toBe(16);
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:bucket",
      "provider:neon:function",
      "provider:neon:object",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
