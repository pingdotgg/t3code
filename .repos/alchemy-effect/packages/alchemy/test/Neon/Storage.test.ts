import { Bucket } from "@/Neon/Bucket";
import { Credential } from "@/Neon/Credential";
import { Project } from "@/Neon/Project";
import { providers } from "@/Neon/Providers";
import { storageLayer } from "@/Neon/Storage";
import * as Test from "@/Test/Alchemy";
import * as S3 from "@distilled.cloud/aws/s3";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import { signStorageRead } from "./fixtures/StorageNative.ts";

const { test } = Test.make({ providers: providers() });

test.provider(
  "read scopes authorize S3 and write-only rejection is typed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { read, write, both } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Project("StorageCredentialProject", {
            region: "aws-us-east-2",
          });
          const read = yield* Credential("Read", {
            project,
            scopes: ["storage:read"],
          });
          const write = yield* Credential("Write", {
            project,
            scopes: ["storage:write"],
          });
          const both = yield* Credential("Both", {
            project,
            scopes: ["storage:read", "storage:write"],
          });
          return { read, write, both };
        }),
      );
      const storage = yield* SDK.getProjectBranchStorage({
        project_id: read.projectId,
        branch_id: read.branchId,
      });
      for (const credential of [read, write, both]) {
        const response = yield* S3.listBuckets({}).pipe(
          Effect.provide(
            storageLayer({
              endpoint: storage.s3_endpoint,
              region: storage.region,
              accessKeyId: credential.tokenId,
              secretAccessKey: credential.s3SecretAccessKey,
            }),
          ),
          Effect.retry({
            while: (error) => error._tag === "AccessDeniedException",
            schedule: Schedule.spaced("500 millis"),
            times: 8,
          }),
          Effect.result,
        );
        const signed = yield* Effect.tryPromise(() =>
          signStorageRead({
            endpoint: storage.s3_endpoint,
            region: storage.region,
            accessKeyId: credential.tokenId,
            secretAccessKey: Redacted.value(credential.s3SecretAccessKey),
          }),
        );
        const native = yield* (yield* HttpClient.HttpClient).get(signed.url, {
          headers: signed.headers,
        });
        yield* Effect.log(
          `Neon scope ${credential.scopes.join(",")}: distilled=${Result.isSuccess(response) ? "ok" : response.failure._tag}; native=${native.status}`,
        );
        if (credential === write) {
          expect(native.status).toBe(403);
          expect(Result.isFailure(response)).toBe(true);
          if (Result.isFailure(response))
            expect(response.failure._tag).toBe("AccessDeniedException");
        } else {
          expect(native.status).toBe(200);
          expect(Result.isSuccess(response)).toBe(true);
        }
      }
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:s3",
      "provider:neon",
      "provider:neon:credential",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

// Neon's docs state storage:write includes all read operations, but the data
// plane enforces write-only strictly: Put/Delete succeed while GetObject,
// HeadObject, ListObjectsV2, and ListBuckets all return AccessDenied
// (measured 2026-09-20; reported upstream). Managed write clients therefore
// request storage:read alongside storage:write. This probe pins the observed
// contract — it fails if Neon ships the documented implied read, at which
// point write clients can drop the extra read scope.
test.provider(
  "storage:write-only is enforced strictly write-only (documented implied read is absent)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { bucket, credential } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Project("WriteImpliesReadProject", {
            region: "aws-us-east-2",
          });
          return {
            bucket: yield* Bucket("Probe", {
              project,
              name: "write-only-probe",
            }),
            credential: yield* Credential("Writer", {
              project,
              scopes: ["storage:write"],
            }),
          };
        }),
      );
      const storage = yield* SDK.getProjectBranchStorage({
        project_id: credential.projectId,
        branch_id: credential.branchId,
      });
      const layer = storageLayer({
        endpoint: storage.s3_endpoint,
        region: storage.region,
        accessKeyId: credential.tokenId,
        secretAccessKey: credential.s3SecretAccessKey,
      });
      const outcome = <A, E>(op: Effect.Effect<A, E, any>) =>
        op.pipe(
          Effect.provide(layer),
          Effect.result,
          Effect.map((result) =>
            Result.isSuccess(result)
              ? "ok"
              : ((result.failure as { _tag: string })._tag ?? "unknown"),
          ),
        );
      const matrix = {
        PutObject: yield* outcome(
          S3.putObject({
            Bucket: bucket.bucketName,
            Key: "probe.txt",
            Body: new TextEncoder().encode("probe"),
          }),
        ),
        GetObject: yield* outcome(
          S3.getObject({ Bucket: bucket.bucketName, Key: "probe.txt" }),
        ),
        HeadObject: yield* outcome(
          S3.headObject({ Bucket: bucket.bucketName, Key: "probe.txt" }),
        ),
        ListObjectsV2: yield* outcome(
          S3.listObjectsV2({ Bucket: bucket.bucketName }),
        ),
        ListBuckets: yield* outcome(S3.listBuckets({})),
        DeleteObject: yield* outcome(
          S3.deleteObject({ Bucket: bucket.bucketName, Key: "probe.txt" }),
        ),
      };
      yield* Effect.log(
        `Neon storage:write-only matrix: ${JSON.stringify(matrix)}`,
      );
      yield* stack.destroy();
      expect(
        yield* SDK.getProject({ project_id: credential.projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* Effect.log("Write-only storage fixture project is absent");
      yield* stack.destroy();
      expect(matrix).toEqual({
        PutObject: "ok",
        GetObject: "AccessDeniedException",
        HeadObject: "AccessDeniedException",
        ListObjectsV2: "AccessDeniedException",
        ListBuckets: "AccessDeniedException",
        DeleteObject: "ok",
      });
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:s3",
      "provider:neon",
      "provider:neon:bucket",
      "provider:neon:credential",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
