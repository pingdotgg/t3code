import { adopt, Unowned } from "@/AdoptPolicy";
import { InstanceId } from "@/InstanceId";
import { createPhysicalName } from "@/PhysicalName";
import * as Provider from "@/Provider";
import { Branch } from "@/Neon/Branch";
import { Credential } from "@/Neon/Credential";
import { Bucket, bucketStorageClient, type BucketProps } from "@/Neon/Bucket";
import { storageBodyBytes } from "@/Neon/Object";
import { makeStorageClient } from "@/Neon/Storage";
import { Project } from "@/Neon/Project";
import { providers } from "@/Neon/Providers";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";

const { test } = Test.make({ providers: providers() });

test.provider(
  "never-created buckets without branch identity are absent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const provider = yield* Provider.findProvider(Bucket);
      const cases: BucketProps[] = [
        { branch: { projectId: "", branchId: "" } },
        { branch: { projectId: "project", branchId: "" } },
        { branch: { projectId: "", branchId: "branch" } },
        { project: { projectId: "" } },
      ];
      for (const olds of cases) {
        expect(
          yield* provider.read!({
            id: "Incomplete",
            fqn: "Incomplete",
            instanceId: "never-created",
            olds,
            output: undefined,
          }),
        ).toBeUndefined();
      }
      yield* stack.destroy();
    }),
  { tags: ["provider:neon", "provider:neon:bucket", "live"] },
);

test.provider(
  "bucket recovery observes tags even without cached identity or explicit name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const instanceId = "0123456789abcdef0123456789abcdef";
      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Project("RecoveryProject", {
            region: "aws-us-east-2",
          });
          const name = yield* createPhysicalName({
            id: "Recovered",
            instanceId,
            maxLength: 63,
            lowercase: true,
          });
          return yield* Bucket("Recovered", {
            project,
            name,
            forceDestroy: true,
          });
        }),
      );
      const client = yield* bucketStorageClient(bucket);
      const provider = yield* Provider.findProvider(Bucket);
      const olds: BucketProps = {
        branch: { projectId: bucket.projectId, branchId: bucket.branchId },
        credential: bucket.credential,
        forceDestroy: true,
      };
      const read = provider.read!({
        id: "Recovered",
        fqn: "Recovered",
        instanceId,
        olds,
        output: undefined,
      }).pipe(Effect.provideService(InstanceId, instanceId));
      yield* Effect.gen(function* () {
        expect(Unowned.is(yield* read)).toBe(false);
        expect((yield* read)?.bucketName).toBe(bucket.bucketName);
        yield* client.putTags({});
        expect(Unowned.is(yield* read)).toBe(true);
        yield* client.putTags({ "alchemy::stack": "another-stack" });
        expect(Unowned.is(yield* read)).toBe(true);
        expect(
          Unowned.is(
            yield* provider.read!({
              id: "Recovered",
              fqn: "Recovered",
              instanceId,
              olds,
              output: bucket,
            }),
          ),
        ).toBe(true);
      }).pipe(Effect.ensuring(client.putTags(bucket.tags).pipe(Effect.orDie)));
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
      "provider:neon:bucket",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "bucket tags CORS anonymous access and multipart cleanup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (updated: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("BucketProject", {
              region: "aws-us-east-2",
            });
            const bucket = yield* Bucket("Private", {
              project,
              tags: updated
                ? { phase: "updated" }
                : { phase: "initial", removed: "yes" },
              cors: updated
                ? []
                : [
                    {
                      AllowedOrigins: ["https://example.com"],
                      AllowedMethods: ["GET", "PUT"],
                    },
                  ],
              forceDestroy: true,
            });
            const publicBucket = yield* Bucket("Public", {
              project,
              access: "public_read",
              forceDestroy: true,
            });
            return { project, bucket, publicBucket };
          }),
        );
      const first = yield* deploy(false);
      const listing = yield* SDK.listProjectBranchBuckets({
        project_id: first.bucket.projectId,
        branch_id: first.bucket.branchId,
      });
      expect(
        listing.buckets.some(
          (bucket) => bucket.name === first.bucket.bucketName,
        ),
      ).toBe(true);
      const client = yield* bucketStorageClient(first.bucket);
      yield* client.put("private.txt", "private");
      const publicClient = yield* bucketStorageClient(first.publicBucket);
      yield* publicClient.put("public.txt", "public");
      const http = yield* HttpClient.HttpClient;
      const privateRead = yield* http.get(
        `${first.bucket.endpoint}/${first.bucket.bucketName}/private.txt`,
      );
      expect([401, 403]).toContain(privateRead.status);
      const publicRead = yield* http.get(
        `${first.publicBucket.endpoint}/${first.publicBucket.bucketName}/public.txt`,
      );
      expect(publicRead.status).toBe(200);
      expect(yield* publicRead.text).toBe("public");
      const updated = yield* deploy(true);
      expect(updated.bucket.bucketName).toBe(first.bucket.bucketName);
      const observed = yield* (yield* bucketStorageClient(
        updated.bucket,
      )).getTags();
      expect(observed.TagSet).toContainEqual({
        Key: "phase",
        Value: "updated",
      });
      expect(observed.TagSet?.some((tag) => tag.Key === "removed")).toBe(false);
      expect((yield* client.getCors()).CORSRules ?? []).toEqual([]);
      const upload = yield* client.createMultipartUpload("unfinished.bin");
      expect(upload.UploadId).toBeDefined();
      yield* client.uploadPart(
        "unfinished.bin",
        upload.UploadId!,
        1,
        new Uint8Array([1, 2, 3]),
      );
      const completed = yield* client.createMultipartUpload("completed.bin");
      const part = yield* client.uploadPart(
        "completed.bin",
        completed.UploadId!,
        1,
        new Uint8Array([4, 5, 6]),
      );
      expect(
        (yield* client.listParts("completed.bin", completed.UploadId!)).Parts
          ?.length,
      ).toBe(1);
      yield* client.completeMultipartUpload(
        "completed.bin",
        completed.UploadId!,
        [{ ETag: part.ETag, PartNumber: 1 }],
      );
      expect((yield* client.head("completed.bin"))?.ContentLength).toBe(3);
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:bucket",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "nonempty bucket deletion and visibility updates fail without destroying data",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (
        forceDestroy = false,
        access: "private" | "public_read" = "private",
      ) =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("SafeBucketProject", {
              region: "aws-us-east-2",
            });
            return yield* Bucket("SafeBucket", {
              project,
              forceDestroy,
              access,
            });
          }),
        );
      const bucket = yield* deploy();
      const client = yield* bucketStorageClient(bucket);
      yield* client.put("retained.txt", "preserve me");
      const visibility = yield* deploy(false, "public_read").pipe(
        Effect.result,
      );
      expect(Result.isFailure(visibility)).toBe(true);
      const listing = yield* SDK.listProjectBranchBuckets({
        project_id: bucket.projectId,
        branch_id: bucket.branchId,
      });
      expect(
        listing.buckets.find((item) => item.name === bucket.bucketName)
          ?.access_level,
      ).toBe("private");
      expect((yield* client.head("retained.txt"))?.ContentLength).toBe(11);
      yield* deploy();
      const deletion = yield* stack.destroy().pipe(Effect.result);
      expect(Result.isFailure(deletion)).toBe(true);
      expect((yield* client.head("retained.txt"))?.ContentLength).toBe(11);
      yield* deploy(true);
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:bucket",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "child storage inherits files while writes and deletes remain branch-local",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const parentProgram = Effect.gen(function* () {
        const project = yield* Project("StorageLineageProject", {
          region: "aws-us-east-2",
        });
        const bucket = yield* Bucket("ParentBucket", {
          project,
          tags: { lineage: "parent" },
          cors: [
            {
              AllowedOrigins: ["https://parent.example.com"],
              AllowedMethods: ["GET"],
            },
          ],
          forceDestroy: true,
        });
        return { project, bucket };
      });
      const parent = yield* stack.deploy(parentProgram);
      const outcome = yield* Effect.gen(function* () {
        const parentClient = yield* bucketStorageClient(parent.bucket);
        yield* parentClient.put("inherited.txt", "parent");
        const parentTags = yield* parentClient.getTags();
        const parentCors = yield* parentClient.getCors();
        const branchProgram = Effect.gen(function* () {
          const { project, bucket } = yield* parentProgram;
          const branch = yield* Branch("ChildBranch", { project });
          return { branch, bucket };
        });
        const { branch } = yield* stack.deploy(branchProgram);
        const provider = yield* Provider.findProvider(Bucket);
        expect(
          Unowned.is(
            yield* provider.read!({
              id: "ChildBucket",
              fqn: "ChildBucket",
              instanceId: "inherited-child",
              olds: {
                branch,
                name: parent.bucket.bucketName,
                credential: parent.bucket.credential,
              },
              output: undefined,
            }),
          ),
        ).toBe(true);
        const deployChild = (updated: boolean) =>
          stack.deploy(
            Effect.gen(function* () {
              const { branch, bucket: parentBucket } = yield* branchProgram;
              const bucket = yield* Bucket("ChildBucket", {
                branch,
                name: parentBucket.bucketName,
                tags: { lineage: updated ? "updated-child" : "child" },
                cors: updated
                  ? []
                  : [
                      {
                        AllowedOrigins: ["https://child.example.com"],
                        AllowedMethods: ["GET"],
                      },
                    ],
                forceDestroy: true,
              }).pipe(adopt(true));
              return { branch, bucket };
            }),
          );
        const child = yield* deployChild(false);
        expect(child.bucket.tags["alchemy::branch"]).toBe(
          child.branch.branchId,
        );
        expect(child.bucket.tags.lineage).toBe("child");
        expect(child.bucket.cors).toEqual([
          {
            AllowedOrigins: ["https://child.example.com"],
            AllowedMethods: ["GET"],
          },
        ]);
        const childClient = yield* bucketStorageClient(child.bucket);
        const inherited = yield* storageBodyBytes(
          (yield* childClient.get("inherited.txt"))?.Body,
        );
        expect(
          yield* Effect.sync(() => new TextDecoder().decode(inherited)),
        ).toBe("parent");
        expect(yield* parentClient.getTags()).toEqual(parentTags);
        expect(yield* parentClient.getCors()).toEqual(parentCors);
        const updated = yield* deployChild(true);
        expect(updated.bucket.bucketName).toBe(child.bucket.bucketName);
        expect(updated.bucket.tags.lineage).toBe("updated-child");
        expect(updated.bucket.cors).toEqual([]);
        expect(yield* parentClient.getTags()).toEqual(parentTags);
        expect(yield* parentClient.getCors()).toEqual(parentCors);
        const ancestorClient = yield* makeStorageClient(
          {
            endpoint: child.bucket.endpoint,
            region: child.bucket.region,
            accessKeyId: parent.bucket.credential.tokenId,
            secretAccessKey: parent.bucket.credential.s3SecretAccessKey,
          },
          child.bucket.bucketName,
        );
        expect(
          (yield* ancestorClient.head("inherited.txt"))?.ContentLength,
        ).toBe(6);
        yield* childClient.put("inherited.txt", "child");
        const original = yield* storageBodyBytes(
          (yield* parentClient.get("inherited.txt"))?.Body,
        );
        expect(
          yield* Effect.sync(() => new TextDecoder().decode(original)),
        ).toBe("parent");
        yield* childClient.delete("inherited.txt");
        expect(yield* childClient.get("inherited.txt")).toBeUndefined();
        expect((yield* parentClient.head("inherited.txt"))?.ContentLength).toBe(
          6,
        );
        yield* stack.deploy(parentProgram);
        expect((yield* parentClient.head("inherited.txt"))?.ContentLength).toBe(
          6,
        );
        expect(yield* parentClient.getTags()).toEqual(parentTags);
        expect(yield* parentClient.getCors()).toEqual(parentCors);
        expect(
          yield* SDK.getProjectBranch({
            project_id: branch.projectId,
            branch_id: branch.branchId,
          }).pipe(
            Effect.as(false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          ),
        ).toBe(true);
      }).pipe(Effect.result);
      yield* stack.destroy();
      expect(
        yield* SDK.getProject({ project_id: parent.project.projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* Effect.log("Inherited storage fixture project is absent");
      yield* stack.destroy();
      if (Result.isFailure(outcome)) return yield* Effect.fail(outcome.failure);
    }),
  {
    tags: [
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

test.provider(
  "inherited S3 data remains isolated and inherited tag rejection is typed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const parentProgram = Effect.gen(function* () {
        const project = yield* Project("StorageDataLineageProject", {
          region: "aws-us-east-2",
        });
        const bucket = yield* Bucket("SourceBucket", {
          project,
          forceDestroy: true,
        });
        return { project, bucket };
      });
      const parent = yield* stack.deploy(parentProgram);
      const parentClient = yield* bucketStorageClient(parent.bucket);
      yield* parentClient.put("inherited.txt", "parent");
      const child = yield* stack.deploy(
        Effect.gen(function* () {
          const { project } = yield* parentProgram;
          const branch = yield* Branch("DataChild", { project });
          const reader = yield* Credential("ChildReader", {
            branch,
            scopes: ["storage:read"],
          });
          return { branch, reader };
        }),
      );
      const storage = yield* SDK.getProjectBranchStorage({
        project_id: child.branch.projectId,
        branch_id: child.branch.branchId,
      });
      const config = {
        endpoint: storage.s3_endpoint,
        region: storage.region,
        accessKeyId: parent.bucket.credential.tokenId,
        secretAccessKey: parent.bucket.credential.s3SecretAccessKey,
      };
      const client = yield* makeStorageClient(config, parent.bucket.bucketName);
      const reader = yield* makeStorageClient(
        {
          ...config,
          accessKeyId: child.reader.tokenId,
          secretAccessKey: child.reader.s3SecretAccessKey,
        },
        parent.bucket.bucketName,
      );
      const bytes = yield* storageBodyBytes(
        (yield* reader.get("inherited.txt"))?.Body,
      );
      expect(yield* Effect.sync(() => new TextDecoder().decode(bytes))).toBe(
        "parent",
      );
      const denied = yield* reader
        .put("denied.txt", "must not write")
        .pipe(Effect.result);
      expect(Result.isFailure(denied)).toBe(true);
      if (Result.isFailure(denied))
        expect(denied.failure._tag).toBe("AccessDeniedException");
      const tagging = yield* client
        .putTags({ phase: "child" })
        .pipe(Effect.result);
      expect(Result.isFailure(tagging)).toBe(true);
      if (Result.isFailure(tagging))
        expect(tagging.failure._tag).toBe("NoSuchBucket");
      yield* client.put("inherited.txt", "child");
      expect((yield* parentClient.head("inherited.txt"))?.ContentLength).toBe(
        6,
      );
      yield* client.delete("inherited.txt");
      expect(yield* client.get("inherited.txt")).toBeUndefined();
      const original = yield* storageBodyBytes(
        (yield* parentClient.get("inherited.txt"))?.Body,
      );
      expect(yield* Effect.sync(() => new TextDecoder().decode(original))).toBe(
        "parent",
      );
      yield* stack.deploy(parentProgram);
      expect((yield* parentClient.head("inherited.txt"))?.ContentLength).toBe(
        6,
      );
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:bucket",
      "provider:neon:credential",
      "provider:neon:object",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "forceDestroy paginates more than one thousand objects",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Project("PaginatedBucketProject", {
            region: "aws-us-east-2",
          });
          return yield* Bucket("PaginatedBucket", {
            project,
            forceDestroy: true,
          });
        }),
      );
      const client = yield* bucketStorageClient(bucket);
      yield* Effect.forEach(
        Array.from({ length: 1001 }, (_, index) => index),
        (index) => client.put(`page/${String(index).padStart(4, "0")}`, "x"),
        { concurrency: 24 },
      );
      const first = yield* client.list({ limit: 1000 });
      expect(first.IsTruncated).toBe(true);
      expect(first.Contents).toHaveLength(1000);
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:bucket",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
