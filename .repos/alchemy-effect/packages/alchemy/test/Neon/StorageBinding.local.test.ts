import { providers } from "@/Neon/Providers";
import { bucketStorageClient } from "@/Neon/Bucket";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import StorageFunction from "./fixtures/StorageFunction.ts";
import { StorageBucket, StorageSettings } from "./fixtures/StorageResources.ts";

const { test } = Test.make({ providers: providers(), dev: true });

test.provider(
  "local Function uses managed storage credentials through the RPC sidecar",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { fn, bucket } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* StorageBucket;
          yield* StorageSettings;
          return { fn: yield* StorageFunction, bucket };
        }),
      );
      expect(fn.functionId.startsWith("dev:")).toBe(true);
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      expect(yield* (yield* http.get(fn.url)).json).toEqual({
        theme: "system",
        pageSize: 25,
      });
      const written = yield* (yield* HttpClient.HttpClient).get(
        `${fn.url}/write`,
      );
      if (written.status !== 200)
        yield* Effect.log("Storage write failed", {
          tag: written.headers["x-storage-error"] ?? "unclassified",
        });
      expect(written.status).toBe(200);
      expect(yield* (yield* http.get(fn.url)).json).toEqual({
        theme: "dark",
        pageSize: 50,
      });
      expect(
        (yield* (yield* bucketStorageClient(bucket)).head("settings.json"))
          ?.ContentType,
      ).toBe("application/json");
      const credentials = (yield* SDK.listCredentials({
        project_id: bucket.projectId,
        branch_id: bucket.branchId,
      })).credentials;
      expect(
        credentials.filter(
          (credential) =>
            credential.branch_id === bucket.branchId && !credential.revoked_at,
        ).length,
      ).toBe(3);
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
