import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { bucketStorageClient, type BucketAttributes } from "@alchemy.run/neon/Bucket";
import { storageBodyBytes } from "@alchemy.run/neon/Object";
import { providers } from "@alchemy.run/neon/Providers";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import StorageHttpLambda from "./fixtures/StorageHttpLambda.ts";
import StorageHttpWorker from "./fixtures/StorageHttpWorker.ts";
import { StorageBucket } from "./fixtures/StorageResources.ts";

const { test: workerTest } = Test.make({
  providers: Layer.mergeAll(providers(), Cloudflare.providers()),
});
const { test: lambdaTest } = Test.make({
  providers: Layer.mergeAll(providers(), AWS.providers()),
});

const verify = Effect.fn(function* (url: string, bucket: BucketAttributes) {
  const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const response = yield* http
    .get(`${url}/write`)
    .pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 8 }));
  expect(response.status).toBe(200);
  expect(yield* (yield* http.get(url)).json).toEqual({
    size: 18,
    hasAccountKey: false,
  });
  const client = yield* bucketStorageClient(bucket);
  const bytes = yield* storageBodyBytes((yield* client.get("external.txt"))?.Body);
  expect(yield* Effect.sync(() => new TextDecoder().decode(bytes))).toBe("external roundtrip");
  const scope = { project_id: bucket.projectId, branch_id: bucket.branchId };
  const credentials = (yield* SDK.listCredentials(scope)).credentials.filter(
    (credential) => credential.branch_id === bucket.branchId && !credential.revoked_at,
  );
  expect(
    credentials.map((credential) => credential.scopes).sort((a, b) => a.length - b.length),
  ).toEqual([
    ["storage:read"],
    ["storage:read", "storage:write"],
    ["storage:read", "storage:write"],
  ]);
  return credentials
    .filter((credential) => credential.token_id !== bucket.credential.tokenId)
    .map((credential) => credential.token_id);
});

workerTest.provider(
  "Worker HTTP storage uses scoped credentials and revokes them when unbound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { worker, bucket } = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* StorageHttpWorker,
            bucket: yield* StorageBucket,
          };
        }),
      );
      const tokens = yield* verify(worker.url!, bucket);
      yield* stack.deploy(StorageBucket);
      const remaining = (yield* SDK.listCredentials({
        project_id: bucket.projectId,
        branch_id: bucket.branchId,
      })).credentials;
      expect(
        remaining.some(
          (credential) => tokens.includes(credential.token_id) && !credential.revoked_at,
        ),
      ).toBe(false);
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:bucket",
      "provider:neon:object",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

lambdaTest.provider(
  "Lambda HTTP storage uses namespaced non-account secrets",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { fn, bucket } = yield* stack.deploy(
        Effect.gen(function* () {
          return { fn: yield* StorageHttpLambda, bucket: yield* StorageBucket };
        }),
      );
      const tokens = yield* verify(fn.functionUrl!, bucket);
      yield* stack.deploy(StorageBucket);
      const remaining = (yield* SDK.listCredentials({
        project_id: bucket.projectId,
        branch_id: bucket.branchId,
      })).credentials;
      expect(
        remaining.some(
          (credential) => tokens.includes(credential.token_id) && !credential.revoked_at,
        ),
      ).toBe(false);
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:lambda",
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:bucket",
      "provider:neon:object",
      "provider:neon:project",
      "live",
    ],
    timeout: 240_000,
  },
);
