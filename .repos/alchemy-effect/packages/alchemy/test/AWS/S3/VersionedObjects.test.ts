import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import * as S3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import VersionedObjectFunctionLive, {
  VersionedObjectFunction,
} from "./fixtures/versioned-object-handler.ts";

const options = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(options);
const stack = Core.scratchStack(
  options,
  "S3VersionedObjects",
  "test/AWS/S3/VersionedObjects.test.ts",
);
const BucketInfo = Schema.Struct({
  bucketName: Schema.String,
  bucketArn: Schema.String,
});
let buckets: Record<string, typeof BucketInfo.Type> = {};
let url: string;
let roleName: string;
class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  body: string;
  message: string;
}> {}
class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

const request = (
  operation: string,
  params: Record<string, string> = {},
  body?: unknown,
) =>
  Effect.gen(function* () {
    const query = yield* Effect.sync(() =>
      new URLSearchParams(params).toString(),
    );
    const endpoint = `${url}/${operation}?${query}`;
    const req =
      body === undefined
        ? HttpClientRequest.get(endpoint)
        : typeof body === "string"
          ? HttpClientRequest.post(endpoint).pipe(
              HttpClientRequest.bodyText(body),
            )
          : HttpClientRequest.post(endpoint).pipe(
              HttpClientRequest.bodyJsonUnsafe(body),
            );
    return yield* HttpClient.execute(req).pipe(
      Effect.flatMap((response) =>
        response.status >= 500
          ? response.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(
                  new NotReady({
                    status: response.status,
                    body,
                    message: `Lambda returned ${response.status}: ${body}`,
                  }),
                ),
              ),
            )
          : Effect.succeed(response),
      ),
      Effect.retry({
        while: (error) => error._tag === "NotReady",
        schedule: Schedule.spaced("4 seconds"),
        times: 9,
      }),
    );
  });
const call = <T>(
  operation: string,
  params: Record<string, string> = {},
  body?: unknown,
) =>
  request(operation, params, body).pipe(
    Effect.flatMap((response) =>
      Effect.gen(function* () {
        const body = yield* response.json;
        expect({ status: response.status, body }).toMatchObject({
          status: 200,
        });
        return body as T;
      }),
    ),
  );
const seed = (operation: string, key = "versions.txt") =>
  Effect.gen(function* () {
    const Bucket = buckets[operation].bucketName;
    const old = yield* S3.putObject({
      Bucket,
      Key: key,
      Body: "old version",
      Tagging: operation.endsWith("Tagging") ? "generation=old" : undefined,
    });
    const current = yield* S3.putObject({
      Bucket,
      Key: key,
      Body: "the current version is longer",
      Tagging: operation.endsWith("Tagging") ? "generation=current" : undefined,
    });
    expect(old.VersionId).toBeTruthy();
    expect(current.VersionId).toBeTruthy();
    expect(old.VersionId).not.toBe(current.VersionId);
    return {
      Bucket,
      Key: key,
      old: old.VersionId!,
      current: current.VersionId!,
    };
  });
const seedNull = (operation: string, Key: string) =>
  Effect.gen(function* () {
    const Bucket = buckets[operation].bucketName;
    yield* Effect.gen(function* () {
      yield* S3.putBucketVersioning({
        Bucket,
        VersioningConfiguration: { Status: "Suspended" },
      });
      yield* S3.putObject({
        Bucket,
        Key,
        Body: "null version",
        Tagging: operation.endsWith("Tagging") ? "generation=null" : undefined,
      });
    }).pipe(
      Effect.ensuring(
        S3.putBucketVersioning({
          Bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }).pipe(Effect.orDie),
      ),
    );
    const current = yield* S3.putObject({
      Bucket,
      Key,
      Body: "current after null",
      Tagging: operation.endsWith("Tagging") ? "generation=current" : undefined,
    });
    expect(current.VersionId).toBeTruthy();
    expect(current.VersionId).not.toBe("null");
    const listed = yield* inventory(Bucket, Key);
    expect(listed.versions.map((version) => version.VersionId).sort()).toEqual(
      ["null", current.VersionId!].sort(),
    );
    expect(yield* read(Bucket, Key, "null")).toBe("null version");
    return { Bucket, Key, current: current.VersionId! };
  });
const inventory = (Bucket: string, Key: string) =>
  S3.listObjectVersions({ Bucket, Prefix: Key, MaxKeys: 1000 }).pipe(
    Effect.map((page) => {
      expect(page.IsTruncated).toBe(false);
      return {
        versions: (page.Versions ?? [])
          .filter((version) => version.Key === Key)
          .map(({ VersionId, ETag, Size, IsLatest }) => ({
            VersionId,
            ETag,
            Size,
            IsLatest,
          }))
          .sort((a, b) => a.VersionId!.localeCompare(b.VersionId!)),
        markers: (page.DeleteMarkers ?? [])
          .filter((marker) => marker.Key === Key)
          .map(({ VersionId, IsLatest }) => ({ VersionId, IsLatest }))
          .sort((a, b) => a.VersionId!.localeCompare(b.VersionId!)),
      };
    }),
  );
const read = (Bucket: string, Key: string, VersionId?: string) =>
  S3.getObject({ Bucket, Key, VersionId }).pipe(
    Effect.flatMap((result) =>
      Stream.mkString(Stream.decodeText(result.Body!)),
    ),
  );
const tags = (Bucket: string, Key: string, VersionId?: string) =>
  S3.getObjectTagging({ Bucket, Key, VersionId }).pipe(
    Effect.map((result) => result.TagSet ?? []),
  );

beforeAll(
  Effect.gen(function* () {
    yield* stack.destroy();
    const fn = yield* stack.deploy(
      VersionedObjectFunction.pipe(Effect.provide(VersionedObjectFunctionLive)),
    );
    url = fn.functionUrl!.replace(/\/+$/, "");
    roleName = fn.roleName;
    buckets = yield* request("info").pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Record(Schema.String, BucketInfo)),
      ),
    );
  }),
  { timeout: 120_000 },
);
afterAll(
  Effect.gen(function* () {
    yield* stack.destroy();
    yield* Core.withProviders(
      Effect.forEach(
        Object.values(buckets),
        (bucket) =>
          S3.headBucket({ Bucket: bucket.bucketName }).pipe(
            Effect.flatMap(() => Effect.fail(new BucketStillExists())),
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.retry({
              while: (error) => error._tag === "BucketStillExists",
              schedule: Schedule.spaced("1 second"),
              times: 9,
            }),
          ),
        { concurrency: 4 },
      ),
      options,
      "S3VersionedObjects",
    );
  }),
  { timeout: 120_000 },
);

const policy = Schema.fromJsonString(
  Schema.Struct({
    Version: Schema.optional(Schema.String),
    Statement: Schema.Array(
      Schema.Struct({
        Sid: Schema.optional(Schema.String),
        Effect: Schema.Literal("Allow"),
        Action: Schema.Array(Schema.String),
        Resource: Schema.Array(Schema.String),
      }),
    ),
  }),
);

describe.sequential(
  "versioned S3 bindings",
  { tags: ["provider:aws", "provider:aws:lambda", "provider:aws:s3", "live"] },
  () => {
    test.provider(
      "isolates each binding's exact grants to its own bucket",
      () =>
        Effect.gen(function* () {
          const attached = yield* IAM.listAttachedRolePolicies
            .pages({ RoleName: roleName })
            .pipe(Stream.runCollect);
          expect(
            attached
              .flatMap((page) => page.AttachedPolicies ?? [])
              .map((p) => p.PolicyArn),
          ).toEqual([
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ]);
          const pages = yield* IAM.listRolePolicies
            .pages({ RoleName: roleName })
            .pipe(Stream.runCollect);
          const documents = yield* Effect.forEach(
            pages.flatMap((page) => page.PolicyNames),
            (PolicyName) =>
              Effect.gen(function* () {
                const result = yield* IAM.getRolePolicy({
                  RoleName: roleName,
                  PolicyName,
                });
                return yield* Schema.decodeUnknownEffect(policy, {
                  onExcessProperty: "error",
                })(
                  yield* Effect.try(() =>
                    decodeURIComponent(result.PolicyDocument),
                  ),
                );
              }),
          );
          const actual = documents
            .flatMap((doc) =>
              doc.Statement.flatMap((s) =>
                s.Action.flatMap((action) =>
                  s.Resource.map((resource) => `${action} ${resource}`),
                ),
              ),
            )
            .sort();
          const grants: Record<
            string,
            { objects?: string[]; bucket?: string[] }
          > = {
            GetObject: {
              objects: ["GetObject", "GetObjectVersion"],
              bucket: ["ListBucket"],
            },
            PutObject: { objects: ["PutObject"] },
            HeadObject: {
              objects: ["GetObject", "GetObjectVersion"],
              bucket: ["ListBucket"],
            },
            GetObjectAttributes: {
              objects: [
                "GetObject",
                "GetObjectVersion",
                "GetObjectAttributes",
                "GetObjectVersionAttributes",
              ],
              bucket: ["ListBucket"],
            },
            CopyObject: {
              objects: ["PutObject", "GetObject", "GetObjectVersion"],
            },
            CopySource: {
              objects: ["GetObject", "GetObjectVersion"],
              bucket: ["ListBucket"],
            },
            DeleteObject: { objects: ["DeleteObject", "DeleteObjectVersion"] },
            DeleteObjects: { objects: ["DeleteObject", "DeleteObjectVersion"] },
            ListObjectsV2: { bucket: ["ListBucket"] },
            ListObjectVersions: { bucket: ["ListBucketVersions"] },
            GetObjectTagging: {
              objects: ["GetObjectTagging", "GetObjectVersionTagging"],
            },
            PutObjectTagging: {
              objects: ["PutObjectTagging", "PutObjectVersionTagging"],
            },
            DeleteObjectTagging: {
              objects: ["DeleteObjectTagging", "DeleteObjectVersionTagging"],
            },
            PresignPutObject: { objects: ["PutObject"] },
          };
          const expected = Object.entries(grants)
            .flatMap(([operation, grants]) => [
              ...(grants.objects ?? []).map(
                (action) => `s3:${action} ${buckets[operation].bucketArn}/*`,
              ),
              ...(grants.bucket ?? []).map(
                (action) => `s3:${action} ${buckets[operation].bucketArn}`,
              ),
            ])
            .sort();
          expect(actual).toEqual(expected);
        }),
      { tags: ["provider:aws:iam"] },
    );

    for (const operation of [
      "GetObject",
      "HeadObject",
      "GetObjectAttributes",
      "GetObjectTagging",
      "PutObjectTagging",
      "DeleteObjectTagging",
    ] as const) {
      describe(operation, () => {
        test.provider(
          "returns typed errors for a deleted version and a selected delete marker",
          () =>
            Effect.gen(function* () {
              const v = yield* seed(operation, "version-errors.txt");
              yield* S3.deleteObject({
                Bucket: v.Bucket,
                Key: v.Key,
                VersionId: v.old,
              });
              const body =
                operation === "PutObjectTagging"
                  ? [{ Key: "generation", Value: "rejected" }]
                  : undefined;
              const remaining = yield* inventory(v.Bucket, v.Key);
              const missing = yield* request(
                operation,
                {
                  key: v.Key,
                  versionId: v.old,
                },
                body,
              );
              expect(missing.status).toBe(
                operation.endsWith("Tagging") ? 403 : 404,
              );
              expect(yield* missing.json).toEqual({
                tag: operation.endsWith("Tagging")
                  ? "AccessDeniedException"
                  : operation === "HeadObject"
                    ? "NotFound"
                    : "NoSuchVersion",
              });
              expect(yield* inventory(v.Bucket, v.Key)).toEqual(remaining);
              const marker = yield* S3.deleteObject({
                Bucket: v.Bucket,
                Key: v.Key,
              });
              expect(marker.VersionId).toBeTruthy();
              const before = yield* inventory(v.Bucket, v.Key);
              const selected = yield* request(
                operation,
                {
                  key: v.Key,
                  versionId: marker.VersionId!,
                },
                body,
              );
              expect(selected.status).toBe(
                operation.endsWith("Tagging") ? 403 : 405,
              );
              if (operation === "HeadObject") {
                const listed = yield* S3.listObjectVersions({
                  Bucket: v.Bucket,
                  Prefix: v.Key,
                });
                const observed = listed.DeleteMarkers?.find(
                  (entry) => entry.VersionId === marker.VersionId,
                );
                expect(observed?.LastModified).toBeDefined();
                expect(yield* selected.json).toEqual({
                  tag: "MethodNotAllowed",
                  deleteMarker: true,
                  lastModified: observed!.LastModified!.toUTCString(),
                });
              } else {
                expect(yield* selected.json).toEqual({
                  tag: operation.endsWith("Tagging")
                    ? "AccessDeniedException"
                    : "MethodNotAllowed",
                });
              }
              expect(yield* inventory(v.Bucket, v.Key)).toEqual(before);
              expect(yield* read(v.Bucket, v.Key, v.current)).toBe(
                "the current version is longer",
              );
              if (operation.endsWith("Tagging")) {
                expect(yield* tags(v.Bucket, v.Key, v.current)).toEqual([
                  { Key: "generation", Value: "current" },
                ]);
              }
            }),
          { timeout: 120_000, retry: 0 },
        );
      });
    }

    for (const operation of [
      "GetObject",
      "HeadObject",
      "GetObjectAttributes",
      "GetObjectTagging",
      "PutObjectTagging",
      "DeleteObjectTagging",
      "DeleteObject",
      "DeleteObjects",
      "CopyObject",
    ] as const) {
      describe(operation, () => {
        test.provider(
          "selects the null version without changing the newer data version",
          () =>
            Effect.gen(function* () {
              const v = yield* seedNull(operation, "null-selection.txt");
              const before = yield* inventory(v.Bucket, v.Key);
              const params = { key: v.Key, versionId: "null" };
              switch (operation) {
                case "GetObject":
                  expect(yield* call(operation, params)).toEqual({
                    body: "null version",
                    versionId: "null",
                  });
                  break;
                case "HeadObject":
                  expect(yield* call(operation, params)).toEqual({
                    length: "null version".length,
                    versionId: "null",
                  });
                  break;
                case "GetObjectAttributes":
                  expect(yield* call(operation, params)).toMatchObject({
                    ObjectSize: "null version".length,
                    VersionId: "null",
                  });
                  break;
                case "GetObjectTagging":
                  expect(yield* call(operation, params)).toEqual({
                    TagSet: [{ Key: "generation", Value: "null" }],
                    VersionId: "null",
                  });
                  break;
                case "PutObjectTagging":
                  yield* call(operation, params, [
                    { Key: "generation", Value: "updated-null" },
                  ]);
                  expect(yield* tags(v.Bucket, v.Key, "null")).toEqual([
                    { Key: "generation", Value: "updated-null" },
                  ]);
                  break;
                case "DeleteObjectTagging":
                  yield* call(operation, params);
                  expect(yield* tags(v.Bucket, v.Key, "null")).toEqual([]);
                  break;
                case "DeleteObject":
                  expect(yield* call(operation, params)).toMatchObject({
                    VersionId: "null",
                  });
                  break;
                case "DeleteObjects": {
                  const deleted = yield* call<S3.DeleteObjectsOutput>(
                    operation,
                    {},
                    [{ Key: v.Key, VersionId: "null" }],
                  );
                  expect(deleted.Errors ?? []).toEqual([]);
                  expect(deleted.Deleted).toEqual([
                    { Key: v.Key, VersionId: "null" },
                  ]);
                  break;
                }
                case "CopyObject": {
                  const copied = yield* call<S3.CopyObjectOutput>(operation, {
                    key: "null-copy.txt",
                    source: `${v.Bucket}/${v.Key}?versionId=null`,
                  });
                  expect(copied.CopySourceVersionId).toBe("null");
                  expect(copied.VersionId).toBeTruthy();
                  expect(yield* read(v.Bucket, "null-copy.txt")).toBe(
                    "null version",
                  );
                  break;
                }
              }
              const after = yield* inventory(v.Bucket, v.Key);
              expect(after).toEqual(
                operation === "DeleteObject" || operation === "DeleteObjects"
                  ? {
                      versions: before.versions.filter(
                        (version) => version.VersionId !== "null",
                      ),
                      markers: [],
                    }
                  : before,
              );
              expect(yield* read(v.Bucket, v.Key)).toBe("current after null");
              expect(yield* tags(v.Bucket, v.Key, v.current)).toEqual(
                operation.endsWith("Tagging")
                  ? [{ Key: "generation", Value: "current" }]
                  : [],
              );
            }),
          { timeout: 120_000, retry: 0 },
        );
      });
    }

    describe("GetObject", () => {
      test.provider(
        "reads current and older contents, including behind a delete marker",
        () =>
          Effect.gen(function* () {
            const v = yield* seed("GetObject");
            expect(yield* call("GetObject", { key: v.Key })).toEqual({
              body: "the current version is longer",
              versionId: v.current,
            });
            expect(
              yield* call("GetObject", { key: v.Key, versionId: v.old }),
            ).toEqual({ body: "old version", versionId: v.old });
            yield* S3.deleteObject({ Bucket: v.Bucket, Key: v.Key });
            const missing = yield* request("GetObject", { key: v.Key });
            expect(missing.status).toBe(404);
            expect(yield* missing.json).toEqual({ tag: "NoSuchKey" });
            expect(
              yield* call("GetObject", { key: v.Key, versionId: v.old }),
            ).toEqual({ body: "old version", versionId: v.old });
          }),
      );
    });

    describe("PutObject", () => {
      test.provider(
        "returns new version IDs on overwrite and preserves both contents",
        () =>
          Effect.gen(function* () {
            const first = yield* call<S3.PutObjectOutput>(
              "PutObject",
              { key: "written.txt" },
              "first write",
            );
            const second = yield* call<S3.PutObjectOutput>(
              "PutObject",
              { key: "written.txt" },
              "second write",
            );
            expect(first.VersionId).toBeTruthy();
            expect(second.VersionId).toBeTruthy();
            expect(second.VersionId).not.toBe(first.VersionId);
            const Bucket = buckets.PutObject.bucketName;
            expect(yield* read(Bucket, "written.txt", first.VersionId)).toBe(
              "first write",
            );
            expect(yield* read(Bucket, "written.txt")).toBe("second write");
          }),
      );
    });

    describe("HeadObject", () => {
      test.provider(
        "reports a current delete marker as missing while older metadata remains readable",
        () =>
          Effect.gen(function* () {
            const v = yield* seed("HeadObject");
            yield* S3.deleteObject({ Bucket: v.Bucket, Key: v.Key });
            const missing = yield* request("HeadObject", { key: v.Key });
            expect(missing.status).toBe(404);
            expect(yield* missing.json).toEqual({ tag: "NotFound" });
            expect(
              yield* call("HeadObject", { key: v.Key, versionId: v.old }),
            ).toEqual({ versionId: v.old, length: "old version".length });
          }),
      );
    });

    describe("GetObjectAttributes", () => {
      test.provider(
        "returns the selected version's size rather than the latest object's size",
        () =>
          Effect.gen(function* () {
            const v = yield* seed("GetObjectAttributes");
            const old = yield* call<S3.GetObjectAttributesOutput>(
              "GetObjectAttributes",
              { key: v.Key, versionId: v.old },
            );
            const current = yield* call<S3.GetObjectAttributesOutput>(
              "GetObjectAttributes",
              { key: v.Key },
            );
            expect(old.VersionId).toBe(v.old);
            expect(old.ObjectSize).toBe("old version".length);
            expect(current.VersionId).toBe(v.current);
            expect(current.ObjectSize).toBe(
              "the current version is longer".length,
            );
          }),
      );
    });

    describe("CopyObject", () => {
      test.provider(
        "rejects a deleted source version and a selected source delete marker without creating destination versions",
        () =>
          Effect.gen(function* () {
            const v = yield* seed("CopySource", "copy-errors.txt");
            const Bucket = buckets.CopyObject.bucketName;
            const Key = "rejected-copy.txt";
            yield* S3.putObject({ Bucket, Key, Body: "unchanged destination" });
            const before = yield* inventory(Bucket, Key);
            yield* S3.deleteObject({
              Bucket: v.Bucket,
              Key: v.Key,
              VersionId: v.old,
            });
            const missing = yield* request("CopyObject", {
              key: Key,
              source: yield* Effect.sync(
                () =>
                  `${v.Bucket}/${v.Key}?versionId=${encodeURIComponent(v.old)}`,
              ),
            });
            expect(missing.status).toBe(404);
            expect(yield* missing.json).toEqual({ tag: "NoSuchVersion" });
            const marker = yield* S3.deleteObject({
              Bucket: v.Bucket,
              Key: v.Key,
            });
            expect(marker.VersionId).toBeTruthy();
            const selected = yield* request("CopyObject", {
              key: Key,
              source: yield* Effect.sync(
                () =>
                  `${v.Bucket}/${v.Key}?versionId=${encodeURIComponent(marker.VersionId!)}`,
              ),
            });
            expect(selected.status).toBe(400);
            expect(yield* selected.json).toEqual({ tag: "InvalidRequest" });
            const currentMarker = yield* request("CopyObject", {
              key: Key,
              source: `${v.Bucket}/${v.Key}`,
            });
            expect(currentMarker.status).toBe(404);
            expect(yield* currentMarker.json).toEqual({ tag: "NoSuchKey" });
            expect(yield* inventory(Bucket, Key)).toEqual(before);
            expect(yield* read(Bucket, Key)).toBe("unchanged destination");
            expect(yield* read(v.Bucket, v.Key, v.current)).toBe(
              "the current version is longer",
            );
          }),
        { timeout: 120_000, retry: 0 },
      );
      test.provider(
        "copies an encoded older source version and creates a new destination version",
        () =>
          Effect.gen(function* () {
            const v = yield* seed("CopyObject", "source/a + #?雪.txt");
            const original = yield* S3.putObject({
              Bucket: v.Bucket,
              Key: "copy.txt",
              Body: "original destination",
            });
            const source = yield* Effect.sync(
              () =>
                `${v.Bucket}/${v.Key.split("/").map(encodeURIComponent).join("/")}?versionId=${encodeURIComponent(v.old)}`,
            );
            const copied = yield* call<S3.CopyObjectOutput>("CopyObject", {
              key: "copy.txt",
              source,
            });
            expect(copied.CopySourceVersionId).toBe(v.old);
            expect(copied.VersionId).toBeTruthy();
            expect(copied.VersionId).not.toBe(original.VersionId);
            expect(yield* read(v.Bucket, "copy.txt")).toBe("old version");
            expect(yield* read(v.Bucket, "copy.txt", original.VersionId)).toBe(
              "original destination",
            );
            const currentSource = yield* Effect.sync(
              () =>
                `${v.Bucket}/${v.Key.split("/").map(encodeURIComponent).join("/")}`,
            );
            yield* call("CopyObject", {
              key: "current-copy.txt",
              source: currentSource,
            });
            expect(yield* read(v.Bucket, "current-copy.txt")).toBe(
              "the current version is longer",
            );
          }),
      );
      test.provider(
        "copies versions from an explicitly bound source and denies an unrelated source",
        () =>
          Effect.gen(function* () {
            const v = yield* seed("CopySource", "cross/source.txt");
            const source = yield* Effect.sync(
              () =>
                `${v.Bucket}/${v.Key}?versionId=${encodeURIComponent(v.old)}`,
            );
            const copied = yield* call<S3.CopyObjectOutput>("CopyObject", {
              key: "cross-destination.txt",
              source,
            });
            expect(copied.CopySourceVersionId).toBe(v.old);
            expect(copied.VersionId).toBeTruthy();
            expect(
              yield* read(
                buckets.CopyObject.bucketName,
                "cross-destination.txt",
              ),
            ).toBe("old version");
            const unrelated = yield* seed("UnboundSource");
            const deniedSource = yield* Effect.sync(
              () =>
                `${unrelated.Bucket}/${unrelated.Key}?versionId=${encodeURIComponent(unrelated.old)}`,
            );
            const denied = yield* request("CopyObject", {
              key: "denied-copy.txt",
              source: deniedSource,
            });
            expect(denied.status).toBe(403);
            expect(yield* denied.json).toMatchObject({
              tag: "AccessDeniedException",
            });
            const absent = yield* S3.headObject({
              Bucket: buckets.CopyObject.bucketName,
              Key: "denied-copy.txt",
            }).pipe(
              Effect.as(false),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            );
            expect(absent).toBe(true);
          }),
      );
    });

    describe("DeleteObject", () => {
      test.provider(
        "creates and removes delete markers and permanently deletes only the selected version",
        () =>
          Effect.gen(function* () {
            const v = yield* seed("DeleteObject");
            const marker = yield* call<S3.DeleteObjectOutput>("DeleteObject", {
              key: v.Key,
            });
            expect(marker.DeleteMarker).toBe(true);
            expect(marker.VersionId).toBeTruthy();
            expect(yield* read(v.Bucket, v.Key, v.old)).toBe("old version");
            const removed = yield* call<S3.DeleteObjectOutput>("DeleteObject", {
              key: v.Key,
              versionId: marker.VersionId!,
            });
            expect(removed.DeleteMarker).toBe(true);
            expect(yield* read(v.Bucket, v.Key)).toBe(
              "the current version is longer",
            );
            yield* call("DeleteObject", { key: v.Key, versionId: v.old });
            const remaining = yield* S3.listObjectVersions({
              Bucket: v.Bucket,
              Prefix: v.Key,
            });
            expect(remaining.Versions?.map((x) => x.VersionId)).toEqual([
              v.current,
            ]);
            expect(remaining.DeleteMarkers ?? []).toEqual([]);
          }),
      );
    });

    describe("DeleteObjects", () => {
      test.provider(
        "mixes explicit version deletion and delete-marker creation without deleting current data",
        () =>
          Effect.gen(function* () {
            const v = yield* seed("DeleteObjects");
            yield* S3.putObject({
              Bucket: v.Bucket,
              Key: "marker.txt",
              Body: "still recoverable",
            });
            const result = yield* call<S3.DeleteObjectsOutput>(
              "DeleteObjects",
              {},
              [{ Key: v.Key, VersionId: v.old }, { Key: "marker.txt" }],
            );
            expect(result.Errors ?? []).toEqual([]);
            expect(
              result.Deleted?.find((x) => x.Key === v.Key)?.VersionId,
            ).toBe(v.old);
            const marker = result.Deleted?.find((x) => x.Key === "marker.txt");
            expect(marker?.DeleteMarker).toBe(true);
            expect(marker?.DeleteMarkerVersionId).toBeTruthy();
            expect(yield* read(v.Bucket, v.Key)).toBe(
              "the current version is longer",
            );
            const remaining = yield* S3.listObjectVersions({
              Bucket: v.Bucket,
              Prefix: v.Key,
            });
            expect(remaining.Versions?.map((x) => x.VersionId)).toEqual([
              v.current,
            ]);
            const restored = yield* call<S3.DeleteObjectsOutput>(
              "DeleteObjects",
              {},
              [{ Key: "marker.txt", VersionId: marker!.DeleteMarkerVersionId }],
            );
            expect(restored.Errors ?? []).toEqual([]);
            expect(yield* read(v.Bucket, "marker.txt")).toBe(
              "still recoverable",
            );
          }),
      );
    });

    describe("ListObjectsV2", () => {
      test.provider(
        "paginates current objects without exposing old versions or delete markers",
        () =>
          Effect.gen(function* () {
            const v = yield* seed("ListObjectsV2", "list/a.txt");
            yield* S3.putObject({
              Bucket: v.Bucket,
              Key: "list/b.txt",
              Body: "visible",
            });
            yield* S3.putObject({
              Bucket: v.Bucket,
              Key: "list/hidden.txt",
              Body: "hidden",
            });
            yield* S3.deleteObject({
              Bucket: v.Bucket,
              Key: "list/hidden.txt",
            });
            const first = yield* call<S3.ListObjectsV2Output>("ListObjectsV2", {
              prefix: "list/",
            });
            expect(first.IsTruncated).toBe(true);
            expect(first.Contents?.map((x) => x.Key)).toEqual(["list/a.txt"]);
            expect(first.Contents?.[0].Size).toBe(
              "the current version is longer".length,
            );
            const second = yield* call<S3.ListObjectsV2Output>(
              "ListObjectsV2",
              {
                prefix: "list/",
                token: first.NextContinuationToken!,
              },
            );
            expect(second.Contents?.map((x) => x.Key)).toEqual(["list/b.txt"]);
            expect(second.IsTruncated).toBe(false);
          }),
      );
    });

    describe("ListObjectVersions", () => {
      test.provider(
        "paginates versions and delete markers using both continuation markers",
        () =>
          Effect.gen(function* () {
            const v = yield* seed("ListObjectVersions");
            const marker = yield* S3.deleteObject({
              Bucket: v.Bucket,
              Key: v.Key,
            });
            const found: string[] = [];
            const markers: string[] = [];
            let params: Record<string, string> = { prefix: v.Key };
            let complete = false;
            for (let page = 0; page < 5; page++) {
              const result = yield* call<S3.ListObjectVersionsOutput>(
                "ListObjectVersions",
                params,
              );
              found.push(...(result.Versions ?? []).map((x) => x.VersionId!));
              markers.push(
                ...(result.DeleteMarkers ?? []).map((x) => x.VersionId!),
              );
              if (!result.IsTruncated) {
                complete = true;
                break;
              }
              expect(result.NextKeyMarker).toBeTruthy();
              expect(result.NextVersionIdMarker).toBeTruthy();
              params = {
                prefix: v.Key,
                keyMarker: result.NextKeyMarker!,
                versionMarker: result.NextVersionIdMarker!,
              };
            }
            expect(complete).toBe(true);
            expect(found.sort()).toEqual([v.old, v.current].sort());
            expect(markers).toEqual([marker.VersionId!]);
          }),
      );
    });

    describe("GetObjectTagging", () => {
      test.provider(
        "reads independent tags for the current and selected old version",
        () =>
          Effect.gen(function* () {
            const v = yield* seed("GetObjectTagging");
            const old = yield* call<S3.GetObjectTaggingOutput>(
              "GetObjectTagging",
              { key: v.Key, versionId: v.old },
            );
            const current = yield* call<S3.GetObjectTaggingOutput>(
              "GetObjectTagging",
              { key: v.Key },
            );
            expect(old.VersionId).toBe(v.old);
            expect(old.TagSet).toEqual([{ Key: "generation", Value: "old" }]);
            expect(current.VersionId).toBe(v.current);
            expect(current.TagSet).toEqual([
              { Key: "generation", Value: "current" },
            ]);
          }),
      );
    });

    describe("PutObjectTagging", () => {
      test.provider(
        "updates the selected old version without mutating current tags",
        () =>
          Effect.gen(function* () {
            const v = yield* seed("PutObjectTagging");
            const before = yield* inventory(v.Bucket, v.Key);
            const updated = [{ Key: "generation", Value: "updated-old" }];
            yield* call(
              "PutObjectTagging",
              { key: v.Key, versionId: v.old },
              updated,
            );
            expect(yield* tags(v.Bucket, v.Key, v.old)).toEqual(updated);
            expect(yield* tags(v.Bucket, v.Key)).toEqual([
              { Key: "generation", Value: "current" },
            ]);
            yield* call("PutObjectTagging", { key: v.Key }, [
              { Key: "generation", Value: "updated-current" },
            ]);
            expect(yield* tags(v.Bucket, v.Key, v.old)).toEqual(updated);
            expect(yield* tags(v.Bucket, v.Key)).toEqual([
              { Key: "generation", Value: "updated-current" },
            ]);
            expect(yield* inventory(v.Bucket, v.Key)).toEqual(before);
            yield* call(
              "PutObjectTagging",
              { key: v.Key, versionId: v.old },
              updated,
            );
            expect(yield* inventory(v.Bucket, v.Key)).toEqual(before);
          }),
      );
    });

    describe("DeleteObjectTagging", () => {
      test.provider("removes only the selected version's tags", () =>
        Effect.gen(function* () {
          const v = yield* seed("DeleteObjectTagging");
          const before = yield* inventory(v.Bucket, v.Key);
          yield* call("DeleteObjectTagging", { key: v.Key, versionId: v.old });
          expect(yield* tags(v.Bucket, v.Key, v.old)).toEqual([]);
          expect(yield* tags(v.Bucket, v.Key)).toEqual([
            { Key: "generation", Value: "current" },
          ]);
          yield* call("DeleteObjectTagging", { key: v.Key });
          expect(yield* tags(v.Bucket, v.Key)).toEqual([]);
          expect(yield* inventory(v.Bucket, v.Key)).toEqual(before);
          yield* call("DeleteObjectTagging", { key: v.Key, versionId: v.old });
          expect(yield* inventory(v.Bucket, v.Key)).toEqual(before);
        }),
      );
    });

    describe("PresignPutObject", () => {
      test.provider(
        "creates a new version without overwriting the previous contents",
        () =>
          Effect.gen(function* () {
            const v = yield* seed("PresignPutObject");
            const signed = yield* call<{ url: string }>("PresignPutObject", {
              key: v.Key,
            });
            const result = yield* HttpClient.execute(
              HttpClientRequest.put(signed.url).pipe(
                HttpClientRequest.bodyText("presigned version", "text/plain"),
              ),
            );
            expect(result.status).toBe(200);
            const version = result.headers["x-amz-version-id"];
            expect(version).toBeTruthy();
            expect(version).not.toBe(v.current);
            expect(yield* read(v.Bucket, v.Key)).toBe("presigned version");
            expect(yield* read(v.Bucket, v.Key, v.current)).toBe(
              "the current version is longer",
            );
            expect(yield* read(v.Bucket, v.Key, v.old)).toBe("old version");
          }),
      );
    });
  },
);
