import * as SDK from "@distilled.cloud/neon";
import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import * as SQL from "alchemy/SQL/Postgres";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({
  providers: Neon.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE ?? "testing",
  stage: "test-neon-compute-preview-isolation",
});
const configured = [
  "PARENT_PROJECT_ID",
  "PARENT_BRANCH_ID",
  "PARENT_BUCKET_NAME",
  "PREVIEW_BRANCH_ID",
].every((name) => !!process.env[name]);

const makeStorageClient = Effect.fn(function* (
  config: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: Redacted.Redacted<string>;
  },
  bucket: string,
) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new S3Client({
          endpoint: config.endpoint,
          region: config.region,
          forcePathStyle: true,
          maxAttempts: 1,
          requestChecksumCalculation: "WHEN_REQUIRED",
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: Redacted.value(config.secretAccessKey),
          },
        }),
    ),
    (client) => Effect.sync(() => client.destroy()),
  );
  return {
    metadata: (key: string) =>
      Effect.tryPromise(() =>
        client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }),
        ),
      ).pipe(
        Effect.map((page) => {
          const object = page.Contents?.find((object) => object.Key === key);
          return object
            ? { ETag: object.ETag, ContentLength: object.Size }
            : undefined;
        }),
      ),
    put: (key: string, body: string, options: { ContentType: string }) =>
      Effect.tryPromise(() =>
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ...options,
          }),
        ),
      ),
    delete: (key: string) =>
      Effect.tryPromise(() =>
        client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
      ),
  };
});

const database = Effect.fn(function* (scope: {
  project_id: string;
  branch_id: string;
}) {
  const databases = yield* SDK.listProjectBranchDatabases(scope);
  const db = databases.databases.find((db) => db.name === "neondb");
  if (!db)
    return yield* Effect.fail(
      new Error("Expected the tutorial neondb database"),
    );
  const connection = yield* SDK.getConnectionURI({
    ...scope,
    database_name: db.name,
    role_name: db.owner_name,
  });
  return yield* SQL.Postgres({ url: Redacted.make(connection.uri) });
});

test.provider.skipIf(!configured)(
  "preview explicitly enables its own upload trigger",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const childTriggers = yield* SDK.listProjectBranchTriggers({
        project_id: process.env.PARENT_PROJECT_ID!,
        branch_id: process.env.PREVIEW_BRANCH_ID!,
      });
      expect(
        childTriggers.triggers.some(
          (trigger) =>
            trigger.name === "PreviewUploads" &&
            trigger.enabled &&
            !trigger.inherited,
        ),
      ).toBe(true);
      yield* stack.destroy();
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  { timeout: 120_000 },
);

test.provider.skipIf(!configured)(
  "preview writes leave parent data and backend configuration unchanged",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const projectId = process.env.PARENT_PROJECT_ID!;
      const parentId = process.env.PARENT_BRANCH_ID!;
      const childId = process.env.PREVIEW_BRANCH_ID!;
      const bucket = process.env.PARENT_BUCKET_NAME!;
      expect(childId).not.toBe(parentId);
      const parent = { project_id: projectId, branch_id: parentId };
      const child = { project_id: projectId, branch_id: childId };
      const observedChild = yield* SDK.getProjectBranch(child);
      expect(observedChild.branch.parent_id).toBe(parentId);
      const parentFunctions = yield* SDK.listProjectBranchFunctions({
        ...parent,
        limit: 1000,
      });
      const childFunctions = yield* SDK.listProjectBranchFunctions({
        ...child,
        limit: 1000,
      });
      expect(parentFunctions.functions.length).toBeGreaterThan(0);
      expect(parentFunctions.pagination?.next).toBeUndefined();
      expect(childFunctions.pagination?.next).toBeUndefined();
      for (const fn of parentFunctions.functions)
        expect(
          childFunctions.functions.some(
            (inherited) => inherited.slug === fn.slug,
          ),
        ).toBe(true);
      const parentTriggers = yield* SDK.listProjectBranchTriggers(parent);
      const childTriggers = yield* SDK.listProjectBranchTriggers(child);
      const inherited = childTriggers.triggers.filter(
        (trigger) => trigger.inherited,
      );
      expect(inherited.length).toBeGreaterThan(0);
      expect(inherited.every((trigger) => !trigger.enabled)).toBe(true);
      const parentDomains = yield* SDK.listProjectBranchCustomDomains(parent);
      const childDomains = yield* SDK.listProjectBranchCustomDomains(child);
      expect(childDomains.custom_domains).toEqual([]);
      const credentials = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            parent: yield* Neon.Credential("ParentRead", {
              branch: { projectId, branchId: parentId },
              scopes: ["storage:read"],
            }),
            child: yield* Neon.Credential("ChildWrite", {
              branch: { projectId, branchId: childId },
              scopes: ["storage:read", "storage:write"],
            }),
          };
        }),
      );
      const parentStorage = yield* SDK.getProjectBranchStorage(parent);
      const childStorage = yield* SDK.getProjectBranchStorage(child);
      const parentFiles = yield* makeStorageClient(
        {
          endpoint: parentStorage.s3_endpoint,
          region: parentStorage.region,
          accessKeyId: credentials.parent.tokenId,
          secretAccessKey: credentials.parent.s3SecretAccessKey,
        },
        bucket,
      );
      const childFiles = yield* makeStorageClient(
        {
          endpoint: childStorage.s3_endpoint,
          region: childStorage.region,
          accessKeyId: credentials.child.tokenId,
          secretAccessKey: credentials.child.s3SecretAccessKey,
        },
        bucket,
      );
      const parentSql = yield* database(parent);
      const childSql = yield* database(child);
      const baseline = yield* parentSql<{
        id: string;
        object_key: string;
        status: string;
      }>`SELECT id, object_key, status FROM uploads ORDER BY id`;
      const sample = baseline.find((row) => row.status === "ready");
      if (!sample)
        return yield* Effect.fail(
          new Error(
            "Process a parent upload before forking; inherited file coverage must not be vacuous",
          ),
        );
      expect(
        (yield* childSql`SELECT id FROM uploads WHERE id = ${sample.id}`)
          .length,
      ).toBe(1);
      const original = yield* parentFiles.metadata(sample.object_key);
      expect(original).toBeDefined();
      expect((yield* childFiles.metadata(sample.object_key))?.ETag).toBe(
        original?.ETag,
      );
      const key = "tutorial-preview/isolation-probe.txt";
      const id = "20000000-0000-4000-8000-000000000002";
      expect(yield* parentFiles.metadata(key)).toBeUndefined();
      expect(yield* childFiles.metadata(key)).toBeUndefined();
      expect(
        (yield* childSql`SELECT id FROM uploads WHERE id = ${id}`).length,
      ).toBe(0);
      yield* Effect.gen(function* () {
        yield* childFiles.put(key, "child only", { ContentType: "text/plain" });
        yield* childSql`INSERT INTO uploads (id, owner_id, object_key, filename, content_type, expected_bytes)
    VALUES (${id}, 'preview-isolation-probe', ${key}, 'isolation-probe.txt', 'text/plain', 10)`;
        expect((yield* childFiles.metadata(key))?.ContentLength).toBe(10);
        expect(
          (yield* childSql`SELECT id FROM uploads WHERE id = ${id}`).length,
        ).toBe(1);
        expect(yield* parentFiles.metadata(key)).toBeUndefined();
        expect(
          yield* parentSql`SELECT id, object_key, status FROM uploads ORDER BY id`,
        ).toEqual(baseline);
        expect(yield* SDK.listProjectBranchTriggers(parent)).toEqual(
          parentTriggers,
        );
        expect(yield* SDK.listProjectBranchCustomDomains(parent)).toEqual(
          parentDomains,
        );
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* childFiles.delete(key);
            yield* childSql`DELETE FROM uploads WHERE id = ${id} AND owner_id = 'preview-isolation-probe'`;
          }).pipe(Effect.orDie),
        ),
      );
      yield* stack.destroy();
      const active = (yield* SDK.listCredentials(child)).credentials.filter(
        (credential) => !credential.revoked_at,
      );
      expect(
        active.some(
          (credential) => credential.token_id === credentials.child.tokenId,
        ),
      ).toBe(false);
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  { timeout: 120_000 },
);
