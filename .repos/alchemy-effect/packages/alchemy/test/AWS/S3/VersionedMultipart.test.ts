import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as S3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import S3VersionedMultipartFunctionLive, {
  S3VersionedMultipartFunction,
} from "./fixtures/versioned-multipart-handler.ts";

const options = { providers: AWS.providers(), dev: false };
const { test, beforeAll, afterAll } = Test.make(options);
const stack = Core.scratchStack(
  options,
  "S3VersionedMultipart",
  "test/AWS/S3/VersionedMultipart.test.ts",
);
const actions = {
  CreateMultipartUpload: ["s3:PutObject"],
  UploadPart: ["s3:PutObject"],
  UploadPartCopy: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
  UploadPartCopySource: ["s3:GetObject", "s3:GetObjectVersion"],
  UploadPartCopyUnboundSource: [],
  ListParts: ["s3:ListMultipartUploadParts"],
  ListMultipartUploads: ["s3:ListBucketMultipartUploads"],
  CompleteMultipartUpload: ["s3:PutObject"],
  AbortMultipartUpload: ["s3:AbortMultipartUpload"],
} as const;
type Binding = keyof typeof actions;
const bucketInfo = Schema.Array(
  Schema.Struct({
    binding: Schema.Literals([
      "CreateMultipartUpload",
      "UploadPart",
      "UploadPartCopy",
      "UploadPartCopySource",
      "UploadPartCopyUnboundSource",
      "ListParts",
      "ListMultipartUploads",
      "CompleteMultipartUpload",
      "AbortMultipartUpload",
    ]),
    bucketName: Schema.String,
    bucketArn: Schema.String,
  }),
);
let buckets: typeof bucketInfo.Type = [];
let baseUrl: string;
let roleName: string;
let functionName: string;

class FixtureNotReady extends Data.TaggedError("FixtureNotReady") {}
class UnexpectedFixtureStatus extends Data.TaggedError(
  "UnexpectedFixtureStatus",
)<{
  readonly status: number;
}> {}
class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

const bucketFor = (binding: Binding) => {
  const bucket = buckets.find((bucket) => bucket.binding === binding);
  if (!bucket) throw new Error(`Missing fixture bucket for ${binding}`);
  return bucket.bucketName;
};

const post = <A, I>(
  path: string,
  body: object,
  schema: Schema.Codec<A, I>,
  expectedStatus = 200,
) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}${path}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );
    if (response.status !== expectedStatus) {
      return yield* Effect.fail(
        new Error(`${path}: HTTP ${response.status}: ${yield* response.text}`),
      );
    }
    return yield* Schema.decodeUnknownEffect(schema)(yield* response.json);
  });

const policyDocument = Schema.fromJsonString(
  Schema.Struct({
    Statement: Schema.Array(
      Schema.Struct({
        Effect: Schema.String,
        Action: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
        Resource: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
      }),
    ),
  }),
);

const assertPermissions = Effect.gen(function* () {
  const configuration = yield* Lambda.getFunctionConfiguration({
    FunctionName: functionName,
  });
  expect(configuration.FunctionName).toBe(functionName);
  expect(configuration.Role?.endsWith(`/${roleName}`)).toBe(true);
  const attached = yield* IAM.listAttachedRolePolicies
    .pages({ RoleName: roleName })
    .pipe(Stream.runCollect);
  expect(
    attached
      .flatMap((page) => page.AttachedPolicies ?? [])
      .map((policy) => policy.PolicyArn),
  ).toEqual([
    "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  ]);
  const pages = yield* IAM.listRolePolicies
    .pages({ RoleName: roleName })
    .pipe(Stream.runCollect);
  const policies = yield* Effect.forEach(
    pages.flatMap((page) => page.PolicyNames),
    (PolicyName) =>
      Effect.gen(function* () {
        const policy = yield* IAM.getRolePolicy({
          RoleName: roleName,
          PolicyName,
        });
        const decoded = yield* Effect.try(() =>
          decodeURIComponent(policy.PolicyDocument),
        );
        return yield* Schema.decodeUnknownEffect(policyDocument)(decoded);
      }),
  );
  const actual = policies
    .flatMap((policy) =>
      policy.Statement.flatMap((statement) => {
        const actionList =
          typeof statement.Action === "string"
            ? [statement.Action]
            : statement.Action;
        const resources =
          typeof statement.Resource === "string"
            ? [statement.Resource]
            : statement.Resource;
        return actionList.flatMap((action) =>
          resources.map(
            (resource) => `${statement.Effect} ${action} ${resource}`,
          ),
        );
      }),
    )
    .sort();
  const expected = buckets
    .flatMap((bucket) => [
      ...actions[bucket.binding].map(
        (action) =>
          `Allow ${action} ${bucket.bucketArn}${bucket.binding === "ListMultipartUploads" ? "" : "/*"}`,
      ),
      ...(bucket.binding === "UploadPartCopySource"
        ? [`Allow s3:ListBucket ${bucket.bucketArn}`]
        : []),
    ])
    .sort();
  expect(actual).toEqual(expected);
  for (const bucket of buckets) {
    expect(
      (yield* S3.getBucketVersioning({ Bucket: bucket.bucketName })).Status,
    ).toBe("Enabled");
  }
});

const assertBucketDeleted = (Bucket: string) =>
  S3.headBucket({ Bucket }).pipe(
    Effect.flatMap(() => Effect.fail(new BucketStillExists())),
    Effect.retry({
      while: (error) => error._tag === "BucketStillExists",
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
    Effect.catchTag("NotFound", () => Effect.void),
  );

const abortPending = (Bucket: string, Key: string, UploadId: string) =>
  S3.abortMultipartUpload({ Bucket, Key, UploadId }).pipe(
    Effect.catchTag("NoSuchUpload", () => Effect.void),
    Effect.orDie,
  );

const withUpload = <A, E, R>(
  Bucket: string,
  Key: string,
  run: (UploadId: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const created = yield* S3.createMultipartUpload({ Bucket, Key });
    expect(created.UploadId).toBeTruthy();
    return yield* run(created.UploadId!).pipe(
      Effect.ensuring(abortPending(Bucket, Key, created.UploadId!)),
    );
  });

const seedVersions = Effect.fn(function* (Bucket: string, Key: string) {
  const oldBody = "original version";
  const currentBody = "current version with a different payload";
  const old = yield* S3.putObject({ Bucket, Key, Body: oldBody });
  const current = yield* S3.putObject({ Bucket, Key, Body: currentBody });
  expect(old.VersionId).toBeTruthy();
  expect(current.VersionId).toBeTruthy();
  expect(old.VersionId).not.toBe("null");
  expect(current.VersionId).not.toBe(old.VersionId);
  return {
    old: old.VersionId!,
    current: current.VersionId!,
    oldBody,
    currentBody,
  };
});

const assertBody = Effect.fn(function* (
  Bucket: string,
  Key: string,
  VersionId: string | undefined,
  body: string,
) {
  const object = yield* S3.getObject({ Bucket, Key, VersionId });
  if (VersionId !== undefined) expect(object.VersionId).toBe(VersionId);
  expect(object.Body).toBeDefined();
  expect(yield* object.Body!.pipe(Stream.decodeText, Stream.mkString)).toBe(
    body,
  );
  return object.VersionId;
});

const assertVersions = Effect.fn(function* (
  Bucket: string,
  Key: string,
  versions: {
    old: string;
    current: string;
    oldBody: string;
    currentBody: string;
  },
) {
  expect(yield* assertBody(Bucket, Key, undefined, versions.currentBody)).toBe(
    versions.current,
  );
  yield* assertBody(Bucket, Key, versions.old, versions.oldBody);
  const listed = yield* S3.listObjectVersions({ Bucket, Prefix: Key });
  expect(
    listed.Versions?.filter((version) => version.Key === Key)
      .map((version) => ({
        id: version.VersionId,
        latest: version.IsLatest,
      }))
      .sort((a, b) => a.id!.localeCompare(b.id!)),
  ).toEqual(
    [
      { id: versions.old, latest: false },
      { id: versions.current, latest: true },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
});

const minimumPartSize = 5 * 1024 * 1024;

const assertCompletedVersion = Effect.fn(function* (
  Bucket: string,
  Key: string,
  versions: {
    old: string;
    current: string;
    oldBody: string;
    currentBody: string;
  },
  VersionId: string,
  Body: string,
) {
  expect(VersionId).toBeTruthy();
  expect(VersionId).not.toBe("null");
  expect(VersionId).not.toBe(versions.old);
  expect(VersionId).not.toBe(versions.current);
  expect(yield* assertBody(Bucket, Key, undefined, Body)).toBe(VersionId);
  yield* assertBody(Bucket, Key, VersionId, Body);
  yield* assertBody(Bucket, Key, versions.old, versions.oldBody);
  yield* assertBody(Bucket, Key, versions.current, versions.currentBody);
  const listed = yield* S3.listObjectVersions({ Bucket, Prefix: Key });
  expect(
    listed.Versions?.filter((version) => version.Key === Key)
      .map((version) => ({
        id: version.VersionId,
        latest: version.IsLatest,
      }))
      .sort((a, b) => a.id!.localeCompare(b.id!)),
  ).toEqual(
    [
      { id: versions.old, latest: false },
      { id: versions.current, latest: false },
      { id: VersionId, latest: true },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
  expect(
    (yield* S3.listMultipartUploads({ Bucket, Prefix: Key })).Uploads ?? [],
  ).toEqual([]);
});

const uploadedPart = Schema.Struct({ ETag: Schema.String });
const completedUpload = Schema.Struct({
  VersionId: Schema.String,
  ETag: Schema.String,
});
const noSuchUpload = Schema.Struct({ tag: Schema.Literal("NoSuchUpload") });

beforeAll(
  Effect.gen(function* () {
    yield* stack.destroy();
    const deployed = yield* stack.deploy(
      S3VersionedMultipartFunction.pipe(
        Effect.provide(S3VersionedMultipartFunctionLive),
      ),
    );
    expect(deployed.functionUrl).toBeTruthy();
    baseUrl = deployed.functionUrl!.replace(/\/+$/, "");
    roleName = deployed.roleName;
    functionName = deployed.functionName;
    buckets = yield* HttpClient.get(`${baseUrl}/info`).pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          if (response.status === 503 || response.status === 502) {
            return yield* Effect.fail(new FixtureNotReady());
          }
          if (response.status === 200) return yield* response.json;
          return yield* Effect.fail(
            new UnexpectedFixtureStatus({ status: response.status }),
          );
        }),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(bucketInfo)),
      Effect.retry({
        while: (error) =>
          error._tag === "FixtureNotReady" ||
          (error._tag === "HttpClientError" &&
            error.reason._tag === "TransportError"),
        schedule: Schedule.spaced("2 seconds"),
        times: 10,
      }),
    );
    expect(buckets.map((bucket) => bucket.binding).sort()).toEqual(
      Object.keys(actions).sort(),
    );
    expect(new Set(buckets.map((bucket) => bucket.bucketName)).size).toBe(9);
    yield* Core.withProviders(
      assertPermissions,
      options,
      "S3VersionedMultipart",
    );
  }),
  { timeout: 120_000, retry: 0 },
);

afterAll(
  Effect.gen(function* () {
    yield* stack.destroy();
    yield* Core.withProviders(
      Effect.forEach(
        buckets,
        (bucket) => assertBucketDeleted(bucket.bucketName),
        { discard: true },
      ),
      options,
      "S3VersionedMultipart",
    );
  }),
  { timeout: 120_000, retry: 0 },
);

describe(
  "CreateMultipartUpload",
  {
    tags: [
      "provider:aws",
      "provider:aws:iam",
      "provider:aws:lambda",
      "provider:aws:s3",
      "live",
    ],
  },
  () => {
    test.provider(
      "creates a pending upload without replacing either existing version",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("CreateMultipartUpload");
          const Key = "versioned-multipart/create.txt";
          const versions = yield* seedVersions(Bucket, Key);
          const created = yield* post(
            "/create",
            { Key, ContentType: "text/markdown" },
            Schema.Struct({
              Bucket: Schema.String,
              Key: Schema.String,
              UploadId: Schema.String,
            }),
          );
          yield* Effect.gen(function* () {
            expect(created.Bucket).toBe(Bucket);
            expect(created.Key).toBe(Key);
            expect(created.UploadId).toBeTruthy();
            const pending = yield* S3.listMultipartUploads({
              Bucket,
              Prefix: Key,
            });
            expect(pending.Uploads?.map((upload) => upload.UploadId)).toContain(
              created.UploadId,
            );
            yield* assertVersions(Bucket, Key, versions);
            const part = yield* S3.uploadPart({
              Bucket,
              Key,
              UploadId: created.UploadId,
              PartNumber: 1,
              Body: "created through Lambda",
            });
            const completed = yield* S3.completeMultipartUpload({
              Bucket,
              Key,
              UploadId: created.UploadId,
              MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag! }] },
            });
            expect(completed.VersionId).toBeTruthy();
            const head = yield* S3.headObject({
              Bucket,
              Key,
              VersionId: completed.VersionId,
            });
            expect(head.ContentType).toBe("text/markdown");
            yield* assertBody(Bucket, Key, versions.old, versions.oldBody);
            yield* assertBody(
              Bucket,
              Key,
              versions.current,
              versions.currentBody,
            );
          }).pipe(Effect.ensuring(abortPending(Bucket, Key, created.UploadId)));
        }),
      { timeout: 120_000, retry: 0 },
    );
  },
);

describe(
  "UploadPart",
  {
    tags: [
      "provider:aws",
      "provider:aws:iam",
      "provider:aws:lambda",
      "provider:aws:s3",
      "live",
    ],
  },
  () => {
    test.provider(
      "rejects an out-of-band aborted upload with typed NoSuchUpload",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("UploadPart");
          const Key = "versioned-multipart/upload-aborted.txt";
          const versions = yield* seedVersions(Bucket, Key);
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              yield* S3.abortMultipartUpload({ Bucket, Key, UploadId });
              expect(
                yield* post(
                  "/upload",
                  { Key, UploadId, PartNumber: 1, Body: "rejected part" },
                  noSuchUpload,
                  404,
                ),
              ).toEqual({ tag: "NoSuchUpload" });
              yield* assertVersions(Bucket, Key, versions);
              expect(
                (yield* S3.listMultipartUploads({ Bucket, Prefix: Key }))
                  .Uploads ?? [],
              ).toEqual([]);
            }),
          );
        }),
      { timeout: 120_000, retry: 0 },
    );

    test.provider(
      "uploads a part through its isolated binding without changing existing versions",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("UploadPart");
          const Key = "versioned-multipart/upload.txt";
          const versions = yield* seedVersions(Bucket, Key);
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              const part = yield* post(
                "/upload",
                {
                  Key,
                  UploadId,
                  PartNumber: 1,
                  Body: "a",
                  Repeat: minimumPartSize,
                },
                uploadedPart,
              );
              const initial = yield* S3.listParts({ Bucket, Key, UploadId });
              expect(
                initial.Parts?.map((entry) => ({
                  part: entry.PartNumber,
                  size: entry.Size,
                  etag: entry.ETag,
                })),
              ).toEqual([{ part: 1, size: minimumPartSize, etag: part.ETag }]);
              yield* assertVersions(Bucket, Key, versions);
              const replacement = yield* post(
                "/upload",
                {
                  Key,
                  UploadId,
                  PartNumber: 1,
                  Body: "b",
                  Repeat: minimumPartSize,
                },
                uploadedPart,
              );
              expect(replacement.ETag).not.toBe(part.ETag);
              const tail = "final part uploaded through Lambda";
              const final = yield* post(
                "/upload",
                { Key, UploadId, PartNumber: 2, Body: tail },
                uploadedPart,
              );
              const listed = yield* S3.listParts({ Bucket, Key, UploadId });
              expect(
                listed.Parts?.map((entry) => ({
                  part: entry.PartNumber,
                  size: entry.Size,
                  etag: entry.ETag,
                })),
              ).toEqual([
                { part: 1, size: minimumPartSize, etag: replacement.ETag },
                { part: 2, size: tail.length, etag: final.ETag },
              ]);
              yield* assertVersions(Bucket, Key, versions);
              const completed = yield* S3.completeMultipartUpload({
                Bucket,
                Key,
                UploadId,
                MultipartUpload: {
                  Parts: [
                    { PartNumber: 1, ETag: replacement.ETag },
                    { PartNumber: 2, ETag: final.ETag },
                  ],
                },
              });
              const Body = yield* Effect.sync(
                () => "b".repeat(minimumPartSize) + tail,
              );
              yield* assertCompletedVersion(
                Bucket,
                Key,
                versions,
                completed.VersionId!,
                Body,
              );
            }),
          );
        }),
      { timeout: 120_000, retry: 0 },
    );
  },
);

describe(
  "UploadPartCopy",
  {
    tags: [
      "provider:aws",
      "provider:aws:iam",
      "provider:aws:lambda",
      "provider:aws:s3",
      "live",
    ],
  },
  () => {
    test.provider(
      "rejects an out-of-band aborted upload with typed NoSuchUpload",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("UploadPartCopy");
          const Key = "versioned-multipart/copy-aborted/destination.txt";
          const sourceBucket = bucketFor("UploadPartCopySource");
          const sourceKey = "versioned-multipart/copy-aborted/source.txt";
          const sourceVersions = yield* seedVersions(sourceBucket, sourceKey);
          const destinationVersions = yield* seedVersions(Bucket, Key);
          const CopySource = yield* Effect.sync(
            () =>
              `${sourceBucket}/${sourceKey}?versionId=${encodeURIComponent(sourceVersions.old)}`,
          );
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              yield* S3.abortMultipartUpload({ Bucket, Key, UploadId });
              expect(
                yield* post(
                  "/copy",
                  { Key, UploadId, PartNumber: 1, CopySource },
                  noSuchUpload,
                  404,
                ),
              ).toEqual({ tag: "NoSuchUpload" });
              yield* assertVersions(sourceBucket, sourceKey, sourceVersions);
              yield* assertVersions(Bucket, Key, destinationVersions);
              expect(
                (yield* S3.listMultipartUploads({ Bucket, Prefix: Key }))
                  .Uploads ?? [],
              ).toEqual([]);
            }),
          );
        }),
      { timeout: 120_000, retry: 0 },
    );

    test.provider(
      "rejects a deleted source version with typed NoSuchVersion",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("UploadPartCopy");
          const Key =
            "versioned-multipart/copy-missing-version/destination.txt";
          const sourceBucket = bucketFor("UploadPartCopySource");
          const sourceKey =
            "versioned-multipart/copy-missing-version/source.txt";
          const sourceVersions = yield* seedVersions(sourceBucket, sourceKey);
          const destinationVersions = yield* seedVersions(Bucket, Key);
          const removed = yield* S3.putObject({
            Bucket: sourceBucket,
            Key: sourceKey,
            Body: "permanently deleted source version",
          });
          expect(removed.VersionId).toBeTruthy();
          yield* S3.deleteObject({
            Bucket: sourceBucket,
            Key: sourceKey,
            VersionId: removed.VersionId!,
          });
          const CopySource = yield* Effect.sync(
            () =>
              `${sourceBucket}/${sourceKey}?versionId=${encodeURIComponent(removed.VersionId!)}`,
          );
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              expect(
                yield* post(
                  "/copy",
                  { Key, UploadId, PartNumber: 1, CopySource },
                  Schema.Struct({ tag: Schema.Literal("NoSuchVersion") }),
                  404,
                ),
              ).toEqual({ tag: "NoSuchVersion" });
              expect(
                (yield* S3.listParts({ Bucket, Key, UploadId })).Parts ?? [],
              ).toEqual([]);
              yield* assertVersions(sourceBucket, sourceKey, sourceVersions);
              yield* assertVersions(Bucket, Key, destinationVersions);
            }),
          );
          expect(
            (yield* S3.listMultipartUploads({ Bucket, Prefix: Key })).Uploads ??
              [],
          ).toEqual([]);
        }),
      { timeout: 120_000, retry: 0 },
    );

    test.provider(
      "rejects an explicitly selected source delete marker with typed InvalidRequest",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("UploadPartCopy");
          const Key = "versioned-multipart/copy-delete-marker/destination.txt";
          const sourceBucket = bucketFor("UploadPartCopySource");
          const sourceKey = "versioned-multipart/copy-delete-marker/source.txt";
          const sourceVersions = yield* seedVersions(sourceBucket, sourceKey);
          const destinationVersions = yield* seedVersions(Bucket, Key);
          const marker = yield* S3.deleteObject({
            Bucket: sourceBucket,
            Key: sourceKey,
          });
          expect(marker.DeleteMarker).toBe(true);
          expect(marker.VersionId).toBeTruthy();
          const sourceState = yield* S3.listObjectVersions({
            Bucket: sourceBucket,
            Prefix: sourceKey,
          });
          expect(
            sourceState.DeleteMarkers?.map((entry) => ({
              id: entry.VersionId,
              latest: entry.IsLatest,
            })),
          ).toEqual([{ id: marker.VersionId, latest: true }]);
          const CopySource = yield* Effect.sync(
            () =>
              `${sourceBucket}/${sourceKey}?versionId=${encodeURIComponent(marker.VersionId!)}`,
          );
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              expect(
                yield* post(
                  "/copy",
                  { Key, UploadId, PartNumber: 1, CopySource },
                  Schema.Struct({ tag: Schema.Literal("InvalidRequest") }),
                  400,
                ),
              ).toEqual({ tag: "InvalidRequest" });
              expect(
                (yield* S3.listParts({ Bucket, Key, UploadId })).Parts ?? [],
              ).toEqual([]);
              yield* assertBody(
                sourceBucket,
                sourceKey,
                sourceVersions.old,
                sourceVersions.oldBody,
              );
              yield* assertBody(
                sourceBucket,
                sourceKey,
                sourceVersions.current,
                sourceVersions.currentBody,
              );
              const after = yield* S3.listObjectVersions({
                Bucket: sourceBucket,
                Prefix: sourceKey,
              });
              expect(after.Versions).toEqual(sourceState.Versions);
              expect(after.DeleteMarkers).toEqual(sourceState.DeleteMarkers);
              yield* assertVersions(Bucket, Key, destinationVersions);
            }),
          );
          expect(
            (yield* S3.listMultipartUploads({ Bucket, Prefix: Key })).Uploads ??
              [],
          ).toEqual([]);
        }),
      { timeout: 120_000, retry: 0 },
    );

    test.provider(
      "copies an encoded source key's old version rather than its differently sized latest version",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("UploadPartCopy");
          const sourceKey =
            "versioned-multipart/source space/+plus%percent/雪?#.txt";
          const Key = "versioned-multipart/destination +%/copy.txt";
          const versions = yield* seedVersions(Bucket, sourceKey);
          const CopySource = yield* Effect.sync(
            () =>
              `${Bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}?versionId=${encodeURIComponent(versions.old)}`,
          );
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              const copied = yield* post(
                "/copy",
                { Key, UploadId, PartNumber: 1, CopySource },
                Schema.Struct({
                  CopySourceVersionId: Schema.String,
                  CopyPartResult: uploadedPart,
                }),
              );
              expect(copied.CopySourceVersionId).toBe(versions.old);
              expect(copied.CopySourceVersionId).not.toBe(versions.current);
              const listed = yield* S3.listParts({ Bucket, Key, UploadId });
              expect(
                listed.Parts?.map((part) => ({
                  size: part.Size,
                  etag: part.ETag,
                })),
              ).toEqual([
                {
                  size: versions.oldBody.length,
                  etag: copied.CopyPartResult.ETag,
                },
              ]);
              const completed = yield* S3.completeMultipartUpload({
                Bucket,
                Key,
                UploadId,
                MultipartUpload: {
                  Parts: [{ PartNumber: 1, ETag: copied.CopyPartResult.ETag }],
                },
              });
              expect(completed.VersionId).toBeTruthy();
              yield* assertBody(
                Bucket,
                Key,
                completed.VersionId!,
                versions.oldBody,
              );
              yield* assertVersions(Bucket, sourceKey, versions);
            }),
          );
        }),
      { timeout: 120_000, retry: 0 },
    );

    test.provider(
      "copies an old version from a separate GetObject-only source bucket",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("UploadPartCopy");
          const sourceBucket = bucketFor("UploadPartCopySource");
          const sourceKey =
            "versioned-multipart/cross-bucket/source +%/雪?#.txt";
          const Key = "versioned-multipart/cross-bucket/destination.txt";
          expect(sourceBucket).not.toBe(Bucket);
          const versions = yield* seedVersions(sourceBucket, sourceKey);
          const CopySource = yield* Effect.sync(
            () =>
              `${sourceBucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}?versionId=${encodeURIComponent(versions.old)}`,
          );
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              const copied = yield* post(
                "/copy",
                { Key, UploadId, PartNumber: 1, CopySource },
                Schema.Struct({
                  CopySourceVersionId: Schema.String,
                  CopyPartResult: uploadedPart,
                }),
              );
              expect(copied.CopySourceVersionId).toBe(versions.old);
              expect(copied.CopySourceVersionId).not.toBe(versions.current);
              const completed = yield* S3.completeMultipartUpload({
                Bucket,
                Key,
                UploadId,
                MultipartUpload: {
                  Parts: [{ PartNumber: 1, ETag: copied.CopyPartResult.ETag }],
                },
              });
              expect(completed.VersionId).toBeTruthy();
              expect(completed.VersionId).not.toBe("null");
              yield* assertBody(
                Bucket,
                Key,
                completed.VersionId!,
                versions.oldBody,
              );
              expect(
                yield* assertBody(Bucket, Key, undefined, versions.oldBody),
              ).toBe(completed.VersionId);
              const head = yield* S3.headObject({
                Bucket,
                Key,
                VersionId: completed.VersionId!,
              });
              expect(head.VersionId).toBe(completed.VersionId);
              expect(head.ETag).toBe(completed.ETag);
              expect(head.ContentLength).toBe(versions.oldBody.length);
              yield* assertVersions(sourceBucket, sourceKey, versions);
            }),
          );
        }),
      { timeout: 120_000, retry: 0 },
    );

    test.provider(
      "rejects an old version in an unbound source bucket with typed AccessDeniedException",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("UploadPartCopy");
          const sourceBucket = bucketFor("UploadPartCopyUnboundSource");
          const sourceKey = "versioned-multipart/unbound/source +%.txt";
          const Key = "versioned-multipart/unbound/destination.txt";
          expect(sourceBucket).not.toBe(Bucket);
          expect(sourceBucket).not.toBe(bucketFor("UploadPartCopySource"));
          const sourceVersions = yield* seedVersions(sourceBucket, sourceKey);
          const destinationVersions = yield* seedVersions(Bucket, Key);
          const CopySource = yield* Effect.sync(
            () =>
              `${sourceBucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}?versionId=${encodeURIComponent(sourceVersions.old)}`,
          );
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              expect(
                yield* post(
                  "/copy",
                  { Key, UploadId, PartNumber: 1, CopySource },
                  Schema.Struct({
                    tag: Schema.Literal("AccessDeniedException"),
                  }),
                  403,
                ),
              ).toEqual({ tag: "AccessDeniedException" });
              expect(
                (yield* S3.listParts({ Bucket, Key, UploadId })).Parts ?? [],
              ).toEqual([]);
              yield* assertVersions(sourceBucket, sourceKey, sourceVersions);
              yield* assertVersions(Bucket, Key, destinationVersions);
            }),
          );
        }),
      { timeout: 120_000, retry: 0 },
    );
  },
);

describe(
  "ListParts",
  {
    tags: [
      "provider:aws",
      "provider:aws:iam",
      "provider:aws:lambda",
      "provider:aws:s3",
      "live",
    ],
  },
  () => {
    test.provider(
      "rejects an out-of-band aborted upload with typed NoSuchUpload",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("ListParts");
          const Key = "versioned-multipart/parts-aborted.txt";
          const versions = yield* seedVersions(Bucket, Key);
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              yield* S3.uploadPart({
                Bucket,
                Key,
                UploadId,
                PartNumber: 1,
                Body: "aborted part",
              });
              yield* S3.abortMultipartUpload({ Bucket, Key, UploadId });
              expect(
                yield* post("/parts", { Key, UploadId }, noSuchUpload, 404),
              ).toEqual({ tag: "NoSuchUpload" });
              yield* assertVersions(Bucket, Key, versions);
              expect(
                (yield* S3.listMultipartUploads({ Bucket, Prefix: Key }))
                  .Uploads ?? [],
              ).toEqual([]);
            }),
          );
        }),
      { timeout: 120_000, retry: 0 },
    );

    test.provider(
      "lists and paginates SDK-seeded parts without touching object versions",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("ListParts");
          const Key = "versioned-multipart/parts.txt";
          const versions = yield* seedVersions(Bucket, Key);
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              const first = yield* S3.uploadPart({
                Bucket,
                Key,
                UploadId,
                PartNumber: 1,
                Body: "first",
              });
              const second = yield* S3.uploadPart({
                Bucket,
                Key,
                UploadId,
                PartNumber: 2,
                Body: "second part",
              });
              const page = Schema.Struct({
                IsTruncated: Schema.Boolean,
                NextPartNumberMarker: Schema.optional(Schema.String),
                Parts: Schema.Array(
                  Schema.Struct({
                    PartNumber: Schema.Number,
                    ETag: Schema.String,
                    Size: Schema.Number,
                  }),
                ),
              });
              const firstPage = yield* post(
                "/parts",
                { Key, UploadId, MaxParts: 1 },
                page,
              );
              expect(firstPage.IsTruncated).toBe(true);
              expect(firstPage.Parts).toEqual([
                { PartNumber: 1, ETag: first.ETag, Size: 5 },
              ]);
              expect(firstPage.NextPartNumberMarker).toBeTruthy();
              const secondPage = yield* post(
                "/parts",
                {
                  Key,
                  UploadId,
                  MaxParts: 1,
                  PartNumberMarker: firstPage.NextPartNumberMarker,
                },
                page,
              );
              expect(secondPage.IsTruncated).toBe(false);
              expect(secondPage.Parts).toEqual([
                { PartNumber: 2, ETag: second.ETag, Size: 11 },
              ]);
              yield* assertVersions(Bucket, Key, versions);
            }),
          );
        }),
      { timeout: 120_000, retry: 0 },
    );
  },
);

describe(
  "ListMultipartUploads",
  {
    tags: [
      "provider:aws",
      "provider:aws:iam",
      "provider:aws:lambda",
      "provider:aws:s3",
      "live",
    ],
  },
  () => {
    test.provider(
      "lists only matching pending uploads, not committed versions or other prefixes",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("ListMultipartUploads");
          const Key = "versioned-multipart/list/matching.txt";
          const versions = yield* seedVersions(Bucket, Key);
          const Prefix = "versioned-multipart/list/";
          const nextKey = `${Prefix}next.txt`;
          const excludedKey = "versioned-multipart/other/excluded.txt";
          const page = Schema.Struct({
            IsTruncated: Schema.Boolean,
            NextKeyMarker: Schema.optional(Schema.String),
            NextUploadIdMarker: Schema.optional(Schema.String),
            Uploads: Schema.Array(
              Schema.Struct({
                Key: Schema.String,
                UploadId: Schema.String,
              }),
            ),
          });
          yield* withUpload(Bucket, Key, (UploadId) =>
            withUpload(Bucket, Key, (siblingId) =>
              withUpload(Bucket, nextKey, (nextId) =>
                withUpload(Bucket, excludedKey, () =>
                  Effect.gen(function* () {
                    const listed = yield* post("/uploads", { Prefix }, page);
                    const expected = [
                      { Key, UploadId },
                      { Key, UploadId: siblingId },
                      { Key: nextKey, UploadId: nextId },
                    ];
                    expect(
                      [...listed.Uploads].sort((a, b) =>
                        a.UploadId.localeCompare(b.UploadId),
                      ),
                    ).toEqual(
                      [...expected].sort((a, b) =>
                        a.UploadId.localeCompare(b.UploadId),
                      ),
                    );
                    const first = yield* post(
                      "/uploads",
                      { Prefix, MaxUploads: 1 },
                      page,
                    );
                    expect(first.IsTruncated).toBe(true);
                    expect(first.Uploads).toHaveLength(1);
                    expect(first.Uploads[0].Key).toBe(Key);
                    expect(first.NextKeyMarker).toBe(Key);
                    expect(first.NextUploadIdMarker).toBe(
                      first.Uploads[0].UploadId,
                    );
                    const second = yield* post(
                      "/uploads",
                      {
                        Prefix,
                        MaxUploads: 1,
                        KeyMarker: first.NextKeyMarker,
                        UploadIdMarker: first.NextUploadIdMarker,
                      },
                      page,
                    );
                    expect(second.IsTruncated).toBe(true);
                    expect(second.Uploads).toHaveLength(1);
                    expect(second.Uploads[0].Key).toBe(Key);
                    expect(second.NextKeyMarker).toBe(Key);
                    expect(second.NextUploadIdMarker).toBe(
                      second.Uploads[0].UploadId,
                    );
                    expect(
                      [
                        first.Uploads[0].UploadId,
                        second.Uploads[0].UploadId,
                      ].sort(),
                    ).toEqual([UploadId, siblingId].sort());
                    const third = yield* post(
                      "/uploads",
                      {
                        Prefix,
                        MaxUploads: 1,
                        KeyMarker: second.NextKeyMarker,
                        UploadIdMarker: second.NextUploadIdMarker,
                      },
                      page,
                    );
                    expect(third.IsTruncated).toBe(false);
                    expect(third.Uploads).toEqual([
                      { Key: nextKey, UploadId: nextId },
                    ]);
                    yield* assertVersions(Bucket, Key, versions);
                  }),
                ),
              ),
            ),
          );
          expect(
            (yield* S3.listMultipartUploads({ Bucket })).Uploads ?? [],
          ).toEqual([]);
        }),
      { timeout: 120_000, retry: 0 },
    );
  },
);

describe(
  "CompleteMultipartUpload",
  {
    tags: [
      "provider:aws",
      "provider:aws:iam",
      "provider:aws:lambda",
      "provider:aws:s3",
      "live",
    ],
  },
  () => {
    test.provider(
      "rejects an out-of-band aborted upload with typed NoSuchUpload",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("CompleteMultipartUpload");
          const Key = "versioned-multipart/complete-aborted.txt";
          const versions = yield* seedVersions(Bucket, Key);
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              const part = yield* S3.uploadPart({
                Bucket,
                Key,
                UploadId,
                PartNumber: 1,
                Body: "aborted part",
              });
              expect(part.ETag).toBeTruthy();
              yield* S3.abortMultipartUpload({ Bucket, Key, UploadId });
              expect(
                yield* post(
                  "/complete",
                  {
                    Key,
                    UploadId,
                    MultipartUpload: {
                      Parts: [{ PartNumber: 1, ETag: part.ETag! }],
                    },
                  },
                  noSuchUpload,
                  404,
                ),
              ).toEqual({ tag: "NoSuchUpload" });
              yield* assertVersions(Bucket, Key, versions);
              expect(
                (yield* S3.listMultipartUploads({ Bucket, Prefix: Key }))
                  .Uploads ?? [],
              ).toEqual([]);
            }),
          );
        }),
      { timeout: 120_000, retry: 0 },
    );

    test.provider(
      "returns a new version while preserving both previous versions",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("CompleteMultipartUpload");
          const Key = "versioned-multipart/complete.txt";
          const versions = yield* seedVersions(Bucket, Key);
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              const firstBody = yield* Effect.sync(() =>
                "c".repeat(minimumPartSize),
              );
              const tail = "new completed multipart version";
              const Body = firstBody + tail;
              const part = yield* S3.uploadPart({
                Bucket,
                Key,
                UploadId,
                PartNumber: 1,
                Body: firstBody,
              });
              const final = yield* S3.uploadPart({
                Bucket,
                Key,
                UploadId,
                PartNumber: 2,
                Body: tail,
              });
              const completed = yield* post(
                "/complete",
                {
                  Key,
                  UploadId,
                  MultipartUpload: {
                    Parts: [
                      { PartNumber: 1, ETag: part.ETag! },
                      { PartNumber: 2, ETag: final.ETag! },
                    ],
                  },
                },
                completedUpload,
              );
              yield* assertCompletedVersion(
                Bucket,
                Key,
                versions,
                completed.VersionId,
                Body,
              );
            }),
          );
        }),
      { timeout: 120_000, retry: 0 },
    );
  },
);

describe(
  "AbortMultipartUpload",
  {
    tags: [
      "provider:aws",
      "provider:aws:iam",
      "provider:aws:lambda",
      "provider:aws:s3",
      "live",
    ],
  },
  () => {
    test.provider(
      "leaves versions and unrelated uploads intact when aborting inactive upload IDs",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("AbortMultipartUpload");
          const Key = "versioned-multipart/invalid-upload-ids.txt";
          const sourceKey = "versioned-multipart/invalid-upload-id-source.txt";
          const versions = yield* seedVersions(Bucket, Key);
          const assertInactiveAbort = (UploadId: string) =>
            Effect.gen(function* () {
              const response = yield* HttpClient.execute(
                HttpClientRequest.post(`${baseUrl}/abort`).pipe(
                  HttpClientRequest.bodyJsonUnsafe({ Key, UploadId }),
                ),
              );
              expect([200, 404]).toContain(response.status);
              expect(yield* response.json).toEqual(
                response.status === 200
                  ? { aborted: true }
                  : { tag: "NoSuchUpload" },
              );
            });
          // Use an issued ID under a different key, not a malformed upload ID.
          yield* withUpload(Bucket, sourceKey, (UploadId) =>
            Effect.gen(function* () {
              yield* assertInactiveAbort(UploadId);
              const pending = yield* S3.listMultipartUploads({
                Bucket,
                Prefix: sourceKey,
              });
              expect(pending.Uploads?.map((upload) => upload.UploadId)).toEqual(
                [UploadId],
              );
              yield* assertVersions(Bucket, Key, versions);
            }),
          );
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              yield* S3.uploadPart({
                Bucket,
                Key,
                UploadId,
                PartNumber: 1,
                Body: "aborted upload bytes",
              });
              yield* post(
                "/abort",
                { Key, UploadId },
                Schema.Struct({ aborted: Schema.Literal(true) }),
              );
              yield* assertInactiveAbort(UploadId);
              yield* assertVersions(Bucket, Key, versions);
            }),
          );
          yield* withUpload(Bucket, Key, (UploadId) =>
            Effect.gen(function* () {
              const Body = "completed upload survives a rejected abort";
              const part = yield* S3.uploadPart({
                Bucket,
                Key,
                UploadId,
                PartNumber: 1,
                Body,
              });
              const completed = yield* S3.completeMultipartUpload({
                Bucket,
                Key,
                UploadId,
                MultipartUpload: {
                  Parts: [{ PartNumber: 1, ETag: part.ETag! }],
                },
              });
              yield* assertInactiveAbort(UploadId);
              yield* assertCompletedVersion(
                Bucket,
                Key,
                versions,
                completed.VersionId!,
                Body,
              );
            }),
          );
          expect(
            (yield* S3.listMultipartUploads({ Bucket, Prefix: Key })).Uploads ??
              [],
          ).toEqual([]);
          expect(
            (yield* S3.listMultipartUploads({ Bucket, Prefix: sourceKey }))
              .Uploads ?? [],
          ).toEqual([]);
        }),
      { timeout: 120_000, retry: 0 },
    );

    test.provider(
      "removes only the selected pending upload, preserving sibling upload and object versions",
      () =>
        Effect.gen(function* () {
          const Bucket = bucketFor("AbortMultipartUpload");
          const Key = "versioned-multipart/abort.txt";
          const versions = yield* seedVersions(Bucket, Key);
          yield* withUpload(Bucket, Key, (UploadId) =>
            withUpload(Bucket, Key, (siblingId) =>
              Effect.gen(function* () {
                yield* S3.uploadPart({
                  Bucket,
                  Key,
                  UploadId,
                  PartNumber: 1,
                  Body: "discard this part",
                });
                const sibling = yield* S3.uploadPart({
                  Bucket,
                  Key,
                  UploadId: siblingId,
                  PartNumber: 1,
                  Body: "keep this part",
                });
                expect(
                  yield* post(
                    "/abort",
                    { Key, UploadId },
                    Schema.Struct({ aborted: Schema.Boolean }),
                  ),
                ).toEqual({ aborted: true });
                const pending = yield* S3.listMultipartUploads({
                  Bucket,
                  Prefix: Key,
                });
                expect(
                  pending.Uploads?.map((upload) => upload.UploadId),
                ).toEqual([siblingId]);
                expect(
                  (yield* S3.listParts({
                    Bucket,
                    Key,
                    UploadId: siblingId,
                  })).Parts?.map((part) => part.ETag),
                ).toEqual([sibling.ETag]);
                yield* assertVersions(Bucket, Key, versions);
              }),
            ),
          );
        }),
      { timeout: 120_000, retry: 0 },
    );
  },
);
