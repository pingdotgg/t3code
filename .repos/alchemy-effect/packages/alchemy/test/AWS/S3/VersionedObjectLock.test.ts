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
import S3VersionedObjectLockFunctionLive, {
  S3VersionedObjectLockFunction,
} from "./fixtures/versioned-object-lock-handler.ts";

const options = { providers: AWS.providers(), dev: false };
const { test, beforeAll, afterAll } = Test.make(options);
const stack = Core.scratchStack(
  options,
  "S3VersionedObjectLock",
  "test/AWS/S3/VersionedObjectLock.test.ts",
);
const actions = {
  GetObjectRetention: "s3:GetObjectRetention",
  PutObjectRetention: "s3:PutObjectRetention",
  GetObjectLegalHold: "s3:GetObjectLegalHold",
  PutObjectLegalHold: "s3:PutObjectLegalHold",
  RestoreObject: "s3:RestoreObject",
} as const;
type Binding = keyof typeof actions;
const bucketInfo = Schema.Array(
  Schema.Struct({
    binding: Schema.Literals([
      "GetObjectRetention",
      "PutObjectRetention",
      "GetObjectLegalHold",
      "PutObjectLegalHold",
      "RestoreObject",
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

const post = <A, I>(path: string, body: object, schema: Schema.Codec<A, I>) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}${path}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );
    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(`${path}: HTTP ${response.status}: ${yield* response.text}`),
      );
    }
    return yield* Schema.decodeUnknownEffect(schema)(yield* response.json);
  });

const rejected = (path: string, body: object, status: number, tag: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}${path}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );
    const result = yield* response.json;
    expect({ status: response.status, body: result }).toEqual({
      status,
      body: { tag },
    });
  });

const assertProtectedDelete = (
  Bucket: string,
  Key: string,
  VersionId: string,
) =>
  S3.deleteObject({ Bucket, Key, VersionId }).pipe(
    Effect.as("deleted"),
    Effect.catchTag("AccessDeniedException", () =>
      Effect.succeed("AccessDeniedException"),
    ),
    Effect.tap((tag) =>
      Effect.sync(() => expect(tag).toBe("AccessDeniedException")),
    ),
  );

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
  expect(actual).toEqual(
    buckets
      .map((bucket) => `Allow ${actions[bucket.binding]} ${bucket.bucketArn}/*`)
      .sort(),
  );
  for (const bucket of buckets) {
    expect(
      (yield* S3.getBucketVersioning({ Bucket: bucket.bucketName })).Status,
    ).toBe("Enabled");
    if (bucket.binding !== "RestoreObject") {
      const lock = yield* S3.getObjectLockConfiguration({
        Bucket: bucket.bucketName,
      });
      expect(lock.ObjectLockConfiguration?.ObjectLockEnabled).toBe("Enabled");
      expect(lock.ObjectLockConfiguration?.Rule).toBeUndefined();
    }
  }
});

const assertBucketDeleted = (Bucket: string) =>
  S3.headBucket({ Bucket }).pipe(
    Effect.flatMap(() => Effect.fail(new BucketStillExists())),
    Effect.retry({
      while: (error) => error._tag === "BucketStillExists",
      schedule: Schedule.spaced("1 second"),
      times: 9,
    }),
    Effect.catchTag("NotFound", () => Effect.void),
  );

const seedVersions = Effect.fn(function* (
  Bucket: string,
  Key: string,
  oldStorageClass: "STANDARD" | "GLACIER" = "STANDARD",
) {
  const oldBody = "original object-lock version";
  const currentBody = "latest object-lock version has different content";
  const old = yield* S3.putObject({
    Bucket,
    Key,
    Body: oldBody,
    StorageClass: oldStorageClass,
  });
  const current = yield* S3.putObject({
    Bucket,
    Key,
    Body: currentBody,
    StorageClass: "STANDARD",
  });
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
  for (const [VersionId, expectedId, body] of [
    [undefined, versions.current, versions.currentBody],
    [versions.old, versions.old, versions.oldBody],
  ] as const) {
    const object = yield* S3.getObject({ Bucket, Key, VersionId });
    expect(object.VersionId).toBe(expectedId);
    expect(object.Body).toBeDefined();
    expect(yield* object.Body!.pipe(Stream.decodeText, Stream.mkString)).toBe(
      body,
    );
  }
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

const retentionDates = Effect.sync(() => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  return {
    old: new Date(now + 86_400_000),
    current: new Date(now + 2 * 86_400_000),
    extended: new Date(now + 3 * 86_400_000),
  };
});

const removeRetention = (Bucket: string, Key: string, versionIds: string[]) =>
  Effect.forEach(
    versionIds,
    (VersionId) =>
      S3.putObjectRetention({
        Bucket,
        Key,
        VersionId,
        Retention: {},
        BypassGovernanceRetention: true,
      }),
    { discard: true },
  ).pipe(Effect.orDie);

const removeHolds = (Bucket: string, Key: string, versionIds: string[]) =>
  Effect.forEach(
    versionIds,
    (VersionId) =>
      S3.putObjectLegalHold({
        Bucket,
        Key,
        VersionId,
        LegalHold: { Status: "OFF" },
      }),
    { discard: true },
  ).pipe(Effect.orDie);

const retentionResponse = Schema.Struct({
  Retention: Schema.Struct({
    Mode: Schema.Literal("GOVERNANCE"),
    RetainUntilDate: Schema.String,
  }),
});
const holdResponse = Schema.Struct({
  LegalHold: Schema.Struct({ Status: Schema.Literals(["ON", "OFF"]) }),
});

beforeAll(
  Effect.gen(function* () {
    yield* stack.destroy();
    const deployed = yield* stack.deploy(
      S3VersionedObjectLockFunction.pipe(
        Effect.provide(S3VersionedObjectLockFunctionLive),
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
        times: 9,
      }),
    );
    expect(buckets.map((bucket) => bucket.binding).sort()).toEqual(
      Object.keys(actions).sort(),
    );
    expect(new Set(buckets.map((bucket) => bucket.bucketName)).size).toBe(5);
    yield* Core.withProviders(
      assertPermissions,
      options,
      "S3VersionedObjectLock",
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
      "S3VersionedObjectLock",
    );
  }),
  { timeout: 120_000, retry: 0 },
);

describe.sequential(
  "versioned object lock bindings",
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
    for (const [binding, path] of [
      ["GetObjectRetention", "/get-retention"],
      ["PutObjectRetention", "/put-retention"],
      ["GetObjectLegalHold", "/get-hold"],
      ["PutObjectLegalHold", "/put-hold"],
      ["RestoreObject", "/restore"],
    ] as const) {
      describe(binding, () => {
        test.provider(
          "returns typed errors for missing versions and a selected delete marker",
          () =>
            Effect.gen(function* () {
              const Bucket = bucketFor(binding);
              const Key = "versioned-object-lock/version-errors.txt";
              const versions = yield* seedVersions(Bucket, Key);
              const dates = yield* retentionDates;
              const input = {
                Key,
                retainUntil: dates.old.toISOString(),
                Status: "OFF",
              };
              yield* Effect.gen(function* () {
                yield* S3.deleteObject({
                  Bucket,
                  Key,
                  VersionId: versions.old,
                });
                for (const VersionId of [versions.old, "null"]) {
                  yield* rejected(
                    path,
                    { ...input, VersionId },
                    403,
                    "AccessDeniedException",
                  );
                }
                const marker = yield* S3.deleteObject({ Bucket, Key });
                expect(marker.VersionId).toBeTruthy();
                yield* rejected(
                  path,
                  { ...input, VersionId: marker.VersionId! },
                  binding === "RestoreObject" ? 405 : 403,
                  binding === "RestoreObject"
                    ? "MethodNotAllowed"
                    : "AccessDeniedException",
                );
                const current = yield* S3.getObject({
                  Bucket,
                  Key,
                  VersionId: versions.current,
                });
                expect(current.VersionId).toBe(versions.current);
                expect(
                  yield* current.Body!.pipe(Stream.decodeText, Stream.mkString),
                ).toBe(versions.currentBody);
                const listed = yield* S3.listObjectVersions({
                  Bucket,
                  Prefix: Key,
                });
                expect(
                  listed.Versions?.map((version) => version.VersionId),
                ).toEqual([versions.current]);
                expect(
                  listed.DeleteMarkers?.map((version) => version.VersionId),
                ).toEqual([marker.VersionId]);
              }).pipe(
                Effect.ensuring(
                  binding === "PutObjectRetention"
                    ? removeRetention(Bucket, Key, [versions.current])
                    : Effect.void,
                ),
              );
            }),
          { timeout: 120_000, retry: 0 },
        );
      });
    }

    describe("GetObjectRetention", () => {
      test.provider(
        "reads the selected old version's retention separately from the latest version",
        () =>
          Effect.gen(function* () {
            const Bucket = bucketFor("GetObjectRetention");
            const Key = "versioned-object-lock/get-retention.txt";
            const versions = yield* seedVersions(Bucket, Key);
            const dates = yield* retentionDates;
            yield* Effect.gen(function* () {
              yield* S3.putObjectRetention({
                Bucket,
                Key,
                VersionId: versions.old,
                Retention: { Mode: "GOVERNANCE", RetainUntilDate: dates.old },
              });
              yield* S3.putObjectRetention({
                Bucket,
                Key,
                VersionId: versions.current,
                Retention: {
                  Mode: "GOVERNANCE",
                  RetainUntilDate: dates.current,
                },
              });
              yield* assertProtectedDelete(Bucket, Key, versions.old);
              const old = yield* post(
                "/get-retention",
                { Key, VersionId: versions.old },
                retentionResponse,
              );
              const current = yield* post(
                "/get-retention",
                { Key },
                retentionResponse,
              );
              expect(old.Retention).toEqual({
                Mode: "GOVERNANCE",
                RetainUntilDate: dates.old.toISOString(),
              });
              expect(current.Retention).toEqual({
                Mode: "GOVERNANCE",
                RetainUntilDate: dates.current.toISOString(),
              });
              expect(old.Retention).not.toEqual(current.Retention);
              expect(
                yield* post(
                  "/get-retention",
                  { Key, VersionId: versions.current },
                  retentionResponse,
                ),
              ).toEqual(current);
              expect(
                (yield* S3.getObjectRetention({
                  Bucket,
                  Key,
                  VersionId: versions.old,
                })).Retention,
              ).toEqual({ Mode: "GOVERNANCE", RetainUntilDate: dates.old });
              expect(
                (yield* S3.getObjectRetention({ Bucket, Key })).Retention,
              ).toEqual({ Mode: "GOVERNANCE", RetainUntilDate: dates.current });
              yield* assertVersions(Bucket, Key, versions);
            }).pipe(
              Effect.ensuring(
                removeRetention(Bucket, Key, [versions.old, versions.current]),
              ),
            );
          }),
        { timeout: 120_000, retry: 0 },
      );
    });

    describe("PutObjectRetention", () => {
      test.provider(
        "extends GOVERNANCE retention on the old version without modifying latest retention",
        () =>
          Effect.gen(function* () {
            const Bucket = bucketFor("PutObjectRetention");
            const Key = "versioned-object-lock/put-retention.txt";
            const versions = yield* seedVersions(Bucket, Key);
            const dates = yield* retentionDates;
            yield* Effect.gen(function* () {
              yield* S3.putObjectRetention({
                Bucket,
                Key,
                VersionId: versions.old,
                Retention: { Mode: "GOVERNANCE", RetainUntilDate: dates.old },
              });
              yield* S3.putObjectRetention({
                Bucket,
                Key,
                VersionId: versions.current,
                Retention: {
                  Mode: "GOVERNANCE",
                  RetainUntilDate: dates.current,
                },
              });
              expect(
                yield* post(
                  "/put-retention",
                  {
                    Key,
                    VersionId: versions.old,
                    retainUntil: dates.extended.toISOString(),
                  },
                  Schema.Struct({ retained: Schema.Boolean }),
                ),
              ).toEqual({ retained: true });
              yield* rejected(
                "/put-retention",
                {
                  Key,
                  VersionId: versions.old,
                  retainUntil: dates.old.toISOString(),
                },
                403,
                "AccessDeniedException",
              );
              yield* assertProtectedDelete(Bucket, Key, versions.old);
              expect(
                (yield* S3.getObjectRetention({
                  Bucket,
                  Key,
                  VersionId: versions.old,
                })).Retention,
              ).toEqual({
                Mode: "GOVERNANCE",
                RetainUntilDate: dates.extended,
              });
              expect(
                (yield* S3.getObjectRetention({ Bucket, Key })).Retention,
              ).toEqual({ Mode: "GOVERNANCE", RetainUntilDate: dates.current });
              expect(
                (yield* S3.getObjectRetention({
                  Bucket,
                  Key,
                  VersionId: versions.current,
                })).Retention,
              ).toEqual({ Mode: "GOVERNANCE", RetainUntilDate: dates.current });
              yield* assertVersions(Bucket, Key, versions);
            }).pipe(
              Effect.ensuring(
                removeRetention(Bucket, Key, [versions.old, versions.current]),
              ),
            );
          }),
        { timeout: 120_000, retry: 0 },
      );
    });

    describe("GetObjectLegalHold", () => {
      test.provider(
        "reads ON for the selected old version and OFF for the current version",
        () =>
          Effect.gen(function* () {
            const Bucket = bucketFor("GetObjectLegalHold");
            const Key = "versioned-object-lock/get-hold.txt";
            const versions = yield* seedVersions(Bucket, Key);
            yield* Effect.gen(function* () {
              yield* S3.putObjectLegalHold({
                Bucket,
                Key,
                VersionId: versions.old,
                LegalHold: { Status: "ON" },
              });
              yield* S3.putObjectLegalHold({
                Bucket,
                Key,
                VersionId: versions.current,
                LegalHold: { Status: "OFF" },
              });
              expect(
                yield* post(
                  "/get-hold",
                  { Key, VersionId: versions.old },
                  holdResponse,
                ),
              ).toEqual({ LegalHold: { Status: "ON" } });
              yield* assertProtectedDelete(Bucket, Key, versions.old);
              expect(yield* post("/get-hold", { Key }, holdResponse)).toEqual({
                LegalHold: { Status: "OFF" },
              });
              expect(
                yield* post(
                  "/get-hold",
                  { Key, VersionId: versions.current },
                  holdResponse,
                ),
              ).toEqual({ LegalHold: { Status: "OFF" } });
              expect(
                (yield* S3.getObjectLegalHold({
                  Bucket,
                  Key,
                  VersionId: versions.old,
                })).LegalHold?.Status,
              ).toBe("ON");
              expect(
                (yield* S3.getObjectLegalHold({ Bucket, Key })).LegalHold
                  ?.Status,
              ).toBe("OFF");
              yield* assertVersions(Bucket, Key, versions);
            }).pipe(
              Effect.ensuring(
                removeHolds(Bucket, Key, [versions.old, versions.current]),
              ),
            );
          }),
        { timeout: 120_000, retry: 0 },
      );
    });

    describe("PutObjectLegalHold", () => {
      test.provider(
        "toggles only the selected old version's legal hold while latest stays OFF",
        () =>
          Effect.gen(function* () {
            const Bucket = bucketFor("PutObjectLegalHold");
            const Key = "versioned-object-lock/put-hold.txt";
            const versions = yield* seedVersions(Bucket, Key);
            yield* Effect.gen(function* () {
              yield* S3.putObjectLegalHold({
                Bucket,
                Key,
                VersionId: versions.old,
                LegalHold: { Status: "OFF" },
              });
              yield* S3.putObjectLegalHold({
                Bucket,
                Key,
                VersionId: versions.current,
                LegalHold: { Status: "OFF" },
              });
              for (const Status of ["ON", "OFF"] as const) {
                expect(
                  yield* post(
                    "/put-hold",
                    { Key, VersionId: versions.old, Status },
                    Schema.Struct({ updated: Schema.Boolean }),
                  ),
                ).toEqual({ updated: true });
                if (Status === "ON") {
                  yield* assertProtectedDelete(Bucket, Key, versions.old);
                }
                expect(
                  (yield* S3.getObjectLegalHold({
                    Bucket,
                    Key,
                    VersionId: versions.old,
                  })).LegalHold?.Status,
                ).toBe(Status);
                expect(
                  (yield* S3.getObjectLegalHold({ Bucket, Key })).LegalHold
                    ?.Status,
                ).toBe("OFF");
                expect(
                  (yield* S3.getObjectLegalHold({
                    Bucket,
                    Key,
                    VersionId: versions.current,
                  })).LegalHold?.Status,
                ).toBe("OFF");
              }
              yield* assertVersions(Bucket, Key, versions);
            }).pipe(
              Effect.ensuring(
                removeHolds(Bucket, Key, [versions.old, versions.current]),
              ),
            );
          }),
        { timeout: 120_000, retry: 0 },
      );
    });

    describe("RestoreObject", () => {
      test.provider(
        "selects a suspended null STANDARD version without changing current data",
        () =>
          Effect.gen(function* () {
            const Bucket = bucketFor("RestoreObject");
            const Key = "versioned-object-lock/restore-null.txt";
            yield* Effect.gen(function* () {
              yield* S3.putBucketVersioning({
                Bucket,
                VersioningConfiguration: { Status: "Suspended" },
              });
              yield* S3.putObject({
                Bucket,
                Key,
                Body: "null restore version",
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
              Body: "current restore version",
            });
            expect(current.VersionId).toBeTruthy();
            expect(current.VersionId).not.toBe("null");
            expect(
              yield* post(
                "/restore",
                { Key, VersionId: "null" },
                Schema.Struct({ tag: Schema.Literal("InvalidObjectState") }),
              ),
            ).toEqual({ tag: "InvalidObjectState" });
            for (const [VersionId, expectedBody] of [
              ["null", "null restore version"],
              [current.VersionId!, "current restore version"],
            ]) {
              const head = yield* S3.headObject({ Bucket, Key, VersionId });
              expect(head.VersionId).toBe(VersionId);
              expect(head.Restore).toBeUndefined();
              const object = yield* S3.getObject({ Bucket, Key, VersionId });
              expect(
                yield* object.Body!.pipe(Stream.decodeText, Stream.mkString),
              ).toBe(expectedBody);
            }
            const listed = yield* S3.listObjectVersions({
              Bucket,
              Prefix: Key,
            });
            expect(
              listed.Versions?.map((version) => ({
                id: version.VersionId,
                latest: version.IsLatest,
              })),
            ).toEqual([
              { id: current.VersionId, latest: true },
              { id: "null", latest: false },
            ]);
            expect(listed.DeleteMarkers ?? []).toEqual([]);
          }),
        { timeout: 120_000, retry: 0 },
      );
      test.provider(
        "returns typed InvalidObjectState for a selected STANDARD version without restoring or changing latest",
        () =>
          Effect.gen(function* () {
            const Bucket = bucketFor("RestoreObject");
            const Key = "versioned-object-lock/restore-standard.txt";
            const versions = yield* seedVersions(Bucket, Key);
            const response = Schema.Struct({
              tag: Schema.Literal("InvalidObjectState"),
            });
            expect(
              yield* post(
                "/restore",
                { Key, VersionId: versions.old },
                response,
              ),
            ).toEqual({ tag: "InvalidObjectState" });
            expect(yield* post("/restore", { Key }, response)).toEqual({
              tag: "InvalidObjectState",
            });
            for (const VersionId of [versions.old, versions.current]) {
              const head = yield* S3.headObject({ Bucket, Key, VersionId });
              expect(head.VersionId).toBe(VersionId);
              expect(head.StorageClass ?? "STANDARD").toBe("STANDARD");
              expect(head.Restore).toBeUndefined();
            }
            yield* assertVersions(Bucket, Key, versions);
          }),
        { timeout: 120_000, retry: 0 },
      );

      test.provider(
        "accepts restoration of an old GLACIER version without waiting for retrieval or changing latest STANDARD",
        () =>
          Effect.gen(function* () {
            const Bucket = bucketFor("RestoreObject");
            const Key = "versioned-object-lock/restore-glacier.txt";
            const versions = yield* seedVersions(Bucket, Key, "GLACIER");
            const archived = yield* S3.headObject({
              Bucket,
              Key,
              VersionId: versions.old,
            });
            expect(archived.VersionId).toBe(versions.old);
            expect(archived.StorageClass).toBe("GLACIER");
            expect(archived.ContentLength).toBe(versions.oldBody.length);
            expect(archived.Restore).toBeUndefined();
            expect(
              yield* post(
                "/restore",
                { Key, VersionId: versions.old },
                Schema.Struct({
                  tag: Schema.Literal("accepted"),
                  versionId: Schema.String,
                }),
              ),
            ).toEqual({ tag: "accepted", versionId: versions.old });

            // Poll only for restore-request visibility, never for retrieval completion.
            const restored = yield* S3.headObject({
              Bucket,
              Key,
              VersionId: versions.old,
            }).pipe(
              Effect.repeat({
                until: (head) => head.Restore !== undefined,
                schedule: Schedule.spaced("2 seconds"),
                times: 9,
              }),
            );
            expect(restored.VersionId).toBe(versions.old);
            expect(restored.StorageClass).toBe("GLACIER");
            expect(restored.ETag).toBe(archived.ETag);
            expect(restored.ContentLength).toBe(archived.ContentLength);
            expect(restored.Restore).toMatch(
              /ongoing-request="(?:true|false)"/,
            );
            const pending = restored.Restore!.includes(
              'ongoing-request="true"',
            );
            if (!pending) {
              expect(restored.Restore).toContain('expiry-date="');
            }
            yield* Effect.logInfo(
              `RestoreObject accepted for ${versions.old}; retrieval ${pending ? "pending" : "completed"}`,
            );

            for (const VersionId of [undefined, versions.current]) {
              const latest = yield* S3.headObject({ Bucket, Key, VersionId });
              expect(latest.VersionId).toBe(versions.current);
              expect(latest.StorageClass ?? "STANDARD").toBe("STANDARD");
              expect(latest.ContentLength).toBe(versions.currentBody.length);
              expect(latest.Restore).toBeUndefined();
            }
            const current = yield* S3.getObject({ Bucket, Key });
            expect(current.VersionId).toBe(versions.current);
            expect(current.Body).toBeDefined();
            expect(
              yield* current.Body!.pipe(Stream.decodeText, Stream.mkString),
            ).toBe(versions.currentBody);
            const listed = yield* S3.listObjectVersions({
              Bucket,
              Prefix: Key,
            });
            expect(
              listed.Versions?.filter((version) => version.Key === Key)
                .map((version) => ({
                  id: version.VersionId,
                  latest: version.IsLatest,
                  storageClass: version.StorageClass,
                }))
                .sort((a, b) => a.id!.localeCompare(b.id!)),
            ).toEqual(
              [
                { id: versions.old, latest: false, storageClass: "GLACIER" },
                {
                  id: versions.current,
                  latest: true,
                  storageClass: "STANDARD",
                },
              ].sort((a, b) => a.id.localeCompare(b.id)),
            );
          }),
        { timeout: 120_000, retry: 0 },
      );
    });
  },
);
