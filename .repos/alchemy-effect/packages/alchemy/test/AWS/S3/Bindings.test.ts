import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import * as S3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import HeadObjectTestFunctionLive, {
  HeadObjectTestFunction,
} from "./fixtures/head-object-handler.ts";
import PresignGetOnlyTestFunctionLive, {
  PresignGetOnlyTestFunction,
} from "./fixtures/presign-get-only-handler.ts";
import S3PresignTestFunctionLive, {
  S3PresignTestFunction,
} from "./fixtures/presign-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "S3Bindings",
  "test/AWS/S3/Bindings.test.ts",
);

// Lambda function URL cold-start (DNS, IAM propagation, init) can take
// well over 60s on a fresh deploy under parallel-suite load. Budget ~150s
// of readiness polling so we don't fail the whole suite on a slow init.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let bucketName: string;
let headUrl: string;
let headRoleName: string;
let headBucket: { bucketName: string; bucketArn: string };
let getOnlyUrl: string;
let getOnlyRoleName: string;
let getOnlyBucket: { bucketName: string; bucketArn: string };

const policyDocument = Schema.fromJsonString(
  Schema.Struct({
    Version: Schema.optional(Schema.String),
    Id: Schema.optional(Schema.String),
    Statement: Schema.Array(
      Schema.Struct({
        Sid: Schema.optional(Schema.String),
        Effect: Schema.String,
        Action: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
        Resource: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
      }),
    ),
  }),
);

const s3RolePermissions = Effect.fn(function* (roleName: string) {
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
    Effect.fn(function* (PolicyName) {
      const policy = yield* IAM.getRolePolicy({
        RoleName: roleName,
        PolicyName,
      });
      const decoded = yield* Effect.try(() =>
        decodeURIComponent(policy.PolicyDocument),
      );
      return yield* Schema.decodeUnknownEffect(policyDocument, {
        onExcessProperty: "error",
      })(decoded);
    }),
  );
  return policies
    .flatMap((policy) =>
      policy.Statement.flatMap((statement) => {
        const actions =
          typeof statement.Action === "string"
            ? [statement.Action]
            : statement.Action;
        const resources =
          typeof statement.Resource === "string"
            ? [statement.Resource]
            : statement.Resource;
        return actions.flatMap((action) =>
          resources.map((resource) => ({
            effect: statement.Effect,
            action,
            resource,
          })),
        );
      }),
    )
    .sort(
      (a, b) =>
        a.action.localeCompare(b.action) ||
        a.resource.localeCompare(b.resource),
    );
});

const readBucketInfo = (url: string) =>
  HttpClient.get(`${url}/info`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`Function not ready: ${response.status}`)),
    ),
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          bucketName: Schema.String,
          bucketArn: Schema.String,
        }),
      ),
    ),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// parallel load (cold re-init). Retry only 5xx; a genuine 4xx/assertion
// failure is surfaced immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

// Drive a fixture route and parse its JSON response. The Lambda role's
// inline policy can take a few seconds to propagate after deploy, so a
// 403-shaped AccessDenied tag from a probe route (or a raw 403) is retried
// by the caller where relevant; transient 5xx are retried by `send`.
const getJson = <T>(path: string) =>
  Effect.gen(function* () {
    const response = yield* send(HttpClientRequest.get(`${baseUrl}${path}`));
    expect(response.status).toBe(200);
    return (yield* response.json) as T;
  });

const route = (pathname: string, params: Record<string, string>) =>
  `${pathname}?${new URLSearchParams(params).toString()}`;

// Probe routes answer `{ tag }` — retry while IAM propagation still yields
// AccessDenied so we assert the *expected* typed platform rejection.
const getTag = (path: string) =>
  getJson<{ tag: string }>(path).pipe(
    Effect.map((body) => body.tag),
    Effect.flatMap((tag): Effect.Effect<string, IamNotPropagated> =>
      tag === "AccessDenied"
        ? Effect.fail(new IamNotPropagated({ status: 403, body: tag }))
        : Effect.succeed(tag),
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "IamNotPropagated",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(8),
      ]),
    }),
  );

// Mint a presigned URL via the deployed Lambda fixture.
const presign = (
  op: "presign-get" | "presign-put",
  params: { key: string; expiresIn?: number; contentType?: string },
) =>
  Effect.gen(function* () {
    const search = new URLSearchParams({ key: params.key });
    if (params.expiresIn !== undefined) {
      search.set("expiresIn", String(params.expiresIn));
    }
    if (params.contentType !== undefined) {
      search.set("contentType", params.contentType);
    }
    const response = yield* send(
      HttpClientRequest.get(`${baseUrl}/${op}?${search.toString()}`),
    );
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { url: string };
    expect(body.url).toContain("X-Amz-Signature=");
    return body.url;
  });

class IamNotPropagated extends Data.TaggedError("IamNotPropagated")<{
  readonly status: number;
  readonly body: string;
}> {}

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

// Out-of-band assert-gone after the final destroy: retry while headBucket
// still succeeds (S3 delete visibility is eventually consistent), settle on
// the typed NotFound.
const assertBucketDeleted = Effect.fn(function* (name: string) {
  yield* S3.headBucket({ Bucket: name }).pipe(
    Effect.flatMap(() => Effect.fail(new BucketStillExists())),
    Effect.retry({
      while: (e) => e._tag === "BucketStillExists",
      schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(10)]),
    }),
    Effect.catchTag("NotFound", () => Effect.void),
  );
});

// The Lambda role's inline policy can take a few seconds to propagate after
// deploy — a structurally valid presigned URL answers 403 until it does.
// Retry 403s on a bounded schedule; any other failure surfaces immediately.
const sendPresigned = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status === 403
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new IamNotPropagated({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "IamNotPropagated",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(8),
      ]),
    }),
  );

describe(
  "S3 Bindings",
  { tags: ["provider:aws", "provider:aws:lambda", "provider:aws:s3", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* Effect.logInfo("S3 test setup: destroying previous resources");
        yield* sharedStack.destroy();

        yield* Effect.logInfo("S3 test setup: deploying presign fixture");
        const functions = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return {
              shared: yield* S3PresignTestFunction,
              head: yield* HeadObjectTestFunction,
              getOnly: yield* PresignGetOnlyTestFunction,
            };
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                S3PresignTestFunctionLive,
                HeadObjectTestFunctionLive,
                PresignGetOnlyTestFunctionLive,
              ),
            ),
          ),
        );

        expect(functions.shared.functionUrl).toBeTruthy();
        baseUrl = functions.shared.functionUrl!.replace(/\/+$/, "");
        headUrl = functions.head.functionUrl!.replace(/\/+$/, "");
        headRoleName = functions.head.roleName;
        getOnlyUrl = functions.getOnly.functionUrl!.replace(/\/+$/, "");
        getOnlyRoleName = functions.getOnly.roleName;
        headBucket = yield* readBucketInfo(headUrl);
        getOnlyBucket = yield* readBucketInfo(getOnlyUrl);
        const readinessUrl = `${baseUrl}/bucket-name`;

        yield* Effect.logInfo(
          `S3 test setup: probing readiness at ${readinessUrl}`,
        );
        // The fixture answers 503 until the runtime hydrates resource
        // Outputs (first-event race after a cold start) — keep retrying
        // until it serves the bucket name.
        const ready = yield* HttpClient.get(readinessUrl).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : Effect.fail(
                  new Error(`Function not ready: ${response.status}`),
                ),
          ),
          Effect.tapError((error) =>
            Effect.logWarning(
              `S3 test setup: fixture not ready yet (${String(error)})`,
            ),
          ),
          Effect.retry({ schedule: readinessPolicy }),
        );
        bucketName = (ready as { bucketName: string }).bucketName;
        expect(bucketName).toBeTruthy();
        yield* Effect.logInfo(
          `S3 test setup: fixture ready (bucket ${bucketName})`,
        );
      }),
      { timeout: 240_000 },
    );

    afterAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        // Prove the trailing destroy really removed the fixture bucket
        // (bucketName is captured in beforeAll; skip if setup never got there).
        // afterAll lacks the providers layer test bodies get, so provide it for
        // the out-of-band distilled call.
        for (const name of [
          bucketName,
          headBucket?.bucketName,
          getOnlyBucket?.bucketName,
        ]) {
          if (name) {
            yield* Core.withProviders(
              assertBucketDeleted(name),
              testOptions,
              "S3Bindings",
            );
          }
        }
      }),
      { timeout: 120_000 },
    );

    describe("PresignPutObject", () => {
      test.provider(
        "uploads a body via a Lambda-minted presigned PUT URL",
        (_stack) =>
          Effect.gen(function* () {
            const key = "presign/upload.txt";
            const body = "uploaded through a presigned PUT URL";

            const url = yield* presign("presign-put", {
              key,
              contentType: "text/plain",
            });

            const putResponse = yield* sendPresigned(
              HttpClientRequest.put(url).pipe(
                HttpClientRequest.bodyText(body, "text/plain"),
              ),
            );
            expect(putResponse.status).toBe(200);

            // out-of-band verification via distilled — the object really landed
            const head = yield* S3.headObject({ Bucket: bucketName, Key: key });
            expect(head.ContentLength).toBe(body.length);
            expect(head.ContentType).toBe("text/plain");
          }),
        { timeout: 120_000 },
      );

      test.provider(
        "rejects an upload whose Content-Type does not match the signature",
        (_stack) =>
          Effect.gen(function* () {
            const url = yield* presign("presign-put", {
              key: "presign/mismatched.txt",
              contentType: "text/plain",
            });

            // Signed for text/plain but sent as application/json — the
            // signature no longer matches, so S3 must reject it.
            const response = yield* HttpClient.execute(
              HttpClientRequest.put(url).pipe(
                HttpClientRequest.bodyText("{}", "application/json"),
              ),
            );
            expect(response.status).toBe(403);
          }),
        { timeout: 120_000 },
      );
    });

    describe("PresignGetObject", () => {
      test.provider(
        "round-trips a body through presigned PUT and GET URLs",
        (_stack) =>
          Effect.gen(function* () {
            const key = "presign/round-trip.txt";
            const body = "presigned round trip payload";

            const putUrl = yield* presign("presign-put", {
              key,
              contentType: "text/plain",
            });
            const putResponse = yield* sendPresigned(
              HttpClientRequest.put(putUrl).pipe(
                HttpClientRequest.bodyText(body, "text/plain"),
              ),
            );
            expect(putResponse.status).toBe(200);

            const getUrl = yield* presign("presign-get", { key });
            const getResponse = yield* sendPresigned(
              HttpClientRequest.get(getUrl),
            );
            expect(getResponse.status).toBe(200);
            expect(yield* getResponse.text).toBe(body);
          }),
        { timeout: 120_000 },
      );

      test.provider(
        "overrides the response Content-Type via contentType",
        (_stack) =>
          Effect.gen(function* () {
            const key = "presign/override.txt";

            // seed the object out-of-band via distilled
            yield* S3.putObject({
              Bucket: bucketName,
              Key: key,
              Body: "override me",
              ContentType: "text/plain",
            });

            const getUrl = yield* presign("presign-get", {
              key,
              contentType: "application/octet-stream",
            });
            const getResponse = yield* sendPresigned(
              HttpClientRequest.get(getUrl),
            );
            expect(getResponse.status).toBe(200);
            expect(getResponse.headers["content-type"]).toBe(
              "application/octet-stream",
            );
            expect(yield* getResponse.text).toBe("override me");
          }),
        { timeout: 120_000 },
      );

      test.provider(
        "expired presigned URLs are rejected",
        (_stack) =>
          Effect.gen(function* () {
            const key = "presign/expiring.txt";
            yield* S3.putObject({
              Bucket: bucketName,
              Key: key,
              Body: "short lived",
            });

            const getUrl = yield* presign("presign-get", {
              key,
              expiresIn: 1,
            });

            // Poll until S3 reports the URL expired (bounded — expiry is 1s,
            // allow a little clock skew between the Lambda signer and S3).
            const status = yield* Effect.gen(function* () {
              const response = yield* HttpClient.execute(
                HttpClientRequest.get(getUrl),
              );
              return response.status;
            }).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (status) => status === 403,
                times: 8,
              }),
            );
            expect(status).toBe(403);
          }),
        { timeout: 120_000 },
      );
    });

    describe("HeadObject", () => {
      test.provider(
        "grants only object reads and bucket-scoped listing",
        () =>
          Effect.gen(function* () {
            expect(yield* s3RolePermissions(headRoleName)).toEqual([
              {
                effect: "Allow",
                action: "s3:GetObject",
                resource: `${headBucket.bucketArn}/*`,
              },
              {
                effect: "Allow",
                action: "s3:GetObjectVersion",
                resource: `${headBucket.bucketArn}/*`,
              },
              {
                effect: "Allow",
                action: "s3:ListBucket",
                resource: headBucket.bucketArn,
              },
            ]);
          }),
        { tags: ["provider:aws:iam"] },
      );

      test.provider(
        "reads current and non-current metadata with only HeadObject bound",
        () =>
          Effect.gen(function* () {
            const key = "head/versions.txt";
            const oldBody = "original metadata";
            const currentBody =
              "updated metadata with a different content length";
            const oldVersion = yield* S3.putObject({
              Bucket: headBucket.bucketName,
              Key: key,
              Body: oldBody,
              ContentType: "text/plain",
            });
            const currentVersion = yield* S3.putObject({
              Bucket: headBucket.bucketName,
              Key: key,
              Body: currentBody,
              ContentType: "text/markdown",
            });
            expect(oldVersion.VersionId).toBeTruthy();
            expect(currentVersion.VersionId).not.toBe(oldVersion.VersionId);
            for (const [params, expected] of [
              [
                { key },
                {
                  contentLength: currentBody.length,
                  contentType: "text/markdown",
                  versionId: currentVersion.VersionId,
                },
              ],
              [
                { key, versionId: oldVersion.VersionId! },
                {
                  contentLength: oldBody.length,
                  contentType: "text/plain",
                  versionId: oldVersion.VersionId,
                },
              ],
            ] as const) {
              const response = yield* send(
                HttpClientRequest.get(`${headUrl}${route("/head", params)}`),
              );
              expect(response.status).toBe(200);
              expect(yield* response.json).toEqual(expected);
            }
          }),
      );

      test.provider(
        "returns typed NotFound for a missing key with only HeadObject bound",
        () =>
          Effect.gen(function* () {
            const response = yield* send(
              HttpClientRequest.get(`${headUrl}/head?key=head/never-created`),
            );
            expect(response.status).toBe(404);
            expect(yield* response.json).toEqual({ tag: "NotFound" });
          }),
      );
    });

    describe("PresignGetObject", () => {
      test.provider(
        "pins downloads across overwrites and signs versioned response overrides and expiry",
        () =>
          Effect.gen(function* () {
            const key = "presign/pinned-before-overwrite.txt";
            const old = yield* S3.putObject({
              Bucket: getOnlyBucket.bucketName,
              Key: key,
              Body: "before overwrite",
            });
            const mint = (versionId?: string, expiresIn = 900) =>
              Effect.gen(function* () {
                const path = yield* Effect.sync(() =>
                  route("/presign", {
                    key,
                    expiresIn: String(expiresIn),
                    contentType: "text/markdown",
                    ...(versionId === undefined ? {} : { versionId }),
                  }),
                );
                const response = yield* send(
                  HttpClientRequest.get(`${getOnlyUrl}${path}`),
                );
                expect(response.status).toBe(200);
                return (yield* response.json.pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(
                      Schema.Struct({ url: Schema.String }),
                    ),
                  ),
                )).url;
              });
            const pinned = yield* mint(old.VersionId!);
            const current = yield* mint();
            const latest = yield* S3.putObject({
              Bucket: getOnlyBucket.bucketName,
              Key: key,
              Body: "after overwrite",
            });
            for (const [url, body, version] of [
              [pinned, "before overwrite", old.VersionId],
              [current, "after overwrite", latest.VersionId],
            ] as const) {
              const response = yield* sendPresigned(HttpClientRequest.get(url));
              expect(yield* response.text).toBe(body);
              expect(response.headers["x-amz-version-id"]).toBe(version);
              expect(response.headers["content-type"]).toBe("text/markdown");
            }
            const expiring = yield* mint(old.VersionId!, 1);
            const status = yield* send(HttpClientRequest.get(expiring)).pipe(
              Effect.map((response) => response.status),
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                times: 8,
                until: (status) => status === 403,
              }),
            );
            expect(status).toBe(403);
          }),
      );

      test.provider(
        "grants only current and versioned object reads",
        () =>
          Effect.gen(function* () {
            expect(yield* s3RolePermissions(getOnlyRoleName)).toEqual([
              {
                effect: "Allow",
                action: "s3:GetObject",
                resource: `${getOnlyBucket.bucketArn}/*`,
              },
              {
                effect: "Allow",
                action: "s3:GetObjectVersion",
                resource: `${getOnlyBucket.bucketArn}/*`,
              },
            ]);
          }),
        { tags: ["provider:aws:iam"] },
      );

      test.provider(
        "downloads current and older versions with only PresignGetObject bound and rejects version tampering",
        () =>
          Effect.gen(function* () {
            const key = "presign/versions/a b+%?#/雪.txt";
            const oldBody = "previous value from an isolated presigner";
            const currentBody = "current value with different bytes and length";
            yield* S3.putBucketVersioning({
              Bucket: getOnlyBucket.bucketName,
              VersioningConfiguration: { Status: "Suspended" },
            });
            yield* S3.putObject({
              Bucket: getOnlyBucket.bucketName,
              Key: key,
              Body: "null version",
            });
            yield* S3.putBucketVersioning({
              Bucket: getOnlyBucket.bucketName,
              VersioningConfiguration: { Status: "Enabled" },
            });
            const oldVersion = yield* S3.putObject({
              Bucket: getOnlyBucket.bucketName,
              Key: key,
              Body: oldBody,
            });
            const currentVersion = yield* S3.putObject({
              Bucket: getOnlyBucket.bucketName,
              Key: key,
              Body: currentBody,
            });
            expect(oldVersion.VersionId).toBeTruthy();
            expect(currentVersion.VersionId).toBeTruthy();
            expect(currentVersion.VersionId).not.toBe(oldVersion.VersionId);
            for (const [versionId, body, expectedVersionId] of [
              [undefined, currentBody, currentVersion.VersionId],
              [
                currentVersion.VersionId!,
                currentBody,
                currentVersion.VersionId,
              ],
              [oldVersion.VersionId!, oldBody, oldVersion.VersionId],
              ["null", "null version", "null"],
            ] as const) {
              const path = yield* Effect.sync(() =>
                route("/presign", {
                  key,
                  ...(versionId === undefined ? {} : { versionId }),
                }),
              );
              const signed = yield* send(
                HttpClientRequest.get(`${getOnlyUrl}${path}`),
              );
              expect(signed.status).toBe(200);
              const result = yield* signed.json.pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(
                    Schema.Struct({ url: Schema.String }),
                  ),
                ),
              );
              const parsed = yield* Effect.sync(() => new URL(result.url));
              expect(parsed.searchParams.get("versionId")).toBe(
                versionId ?? null,
              );
              expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(
                /^[0-9a-f]{64}$/,
              );
              expect(
                yield* Effect.sync(() => decodeURIComponent(parsed.pathname)),
              ).toBe(`/${key}`);
              expect(parsed.hash).toBe("");
              if (versionId === oldVersion.VersionId) {
                yield* S3.deleteObject({
                  Bucket: getOnlyBucket.bucketName,
                  Key: key,
                });
              }
              const downloaded = yield* sendPresigned(
                HttpClientRequest.get(result.url),
              );
              expect(downloaded.status).toBe(200);
              expect(yield* downloaded.text).toBe(body);
              expect(downloaded.headers["x-amz-version-id"]).toBe(
                expectedVersionId,
              );

              const tamperedUrl = yield* Effect.sync(() => {
                const url = new URL(result.url);
                url.searchParams.set(
                  "versionId",
                  versionId === oldVersion.VersionId
                    ? currentVersion.VersionId!
                    : oldVersion.VersionId!,
                );
                return url.toString();
              });
              const tampered = yield* send(HttpClientRequest.get(tamperedUrl));
              expect(tampered.status).toBe(403);
              expect(yield* tampered.text).toContain(
                "<Code>SignatureDoesNotMatch</Code>",
              );

              if (versionId !== undefined) {
                const withoutVersion = yield* Effect.sync(() => {
                  const url = new URL(result.url);
                  url.searchParams.delete("versionId");
                  return url.toString();
                });
                const removed = yield* send(
                  HttpClientRequest.get(withoutVersion),
                );
                expect(removed.status).toBe(403);
                expect(yield* removed.text).toContain(
                  "<Code>SignatureDoesNotMatch</Code>",
                );
              }
            }
          }),
      );
    });

    const seed = (key: string, body: string) =>
      S3.putObject({ Bucket: bucketName, Key: key, Body: body });

    describe("DeleteObjects", () => {
      test.provider(
        "batch-deletes several objects in one call",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("batch/one.txt", "first");
            yield* seed("batch/two.txt", "second");

            const result = yield* getJson<{
              deleted: string[];
              errors: string[];
            }>(
              route("/delete-objects", { keys: "batch/one.txt,batch/two.txt" }),
            );
            expect(result.errors).toEqual([]);
            expect(result.deleted).toContain("batch/one.txt");
            expect(result.deleted).toContain("batch/two.txt");

            // out-of-band verification via distilled — the objects are gone
            const head = yield* S3.headObject({
              Bucket: bucketName,
              Key: "batch/one.txt",
            }).pipe(
              Effect.map(() => "found" as const),
              Effect.catchTag("NotFound", () =>
                Effect.succeed("not-found" as const),
              ),
            );
            expect(head).toBe("not-found");
          }),
        { timeout: 120_000 },
      );
    });

    describe("PutObjectTagging", () => {
      test.provider(
        "replaces an object's tag set",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("tagging/put.txt", "tag me");

            yield* getJson<{ ok: boolean }>(
              route("/put-tagging", {
                key: "tagging/put.txt",
                tagKey: "env",
                tagValue: "prod",
              }),
            );

            // out-of-band verification via distilled
            const tags = yield* S3.getObjectTagging({
              Bucket: bucketName,
              Key: "tagging/put.txt",
            });
            expect(tags.TagSet).toEqual([{ Key: "env", Value: "prod" }]);
          }),
        { timeout: 120_000 },
      );
    });

    describe("GetObjectTagging", () => {
      test.provider(
        "reads an object's tag set",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("tagging/get.txt", "tagged");
            yield* S3.putObjectTagging({
              Bucket: bucketName,
              Key: "tagging/get.txt",
              Tagging: { TagSet: [{ Key: "team", Value: "alchemy" }] },
            });

            const result = yield* getJson<{ tags: Record<string, string> }>(
              route("/get-tagging", { key: "tagging/get.txt" }),
            );
            expect(result.tags).toEqual({ team: "alchemy" });
          }),
        { timeout: 120_000 },
      );
    });

    describe("DeleteObjectTagging", () => {
      test.provider(
        "removes an object's entire tag set",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("tagging/delete.txt", "untag me");
            yield* S3.putObjectTagging({
              Bucket: bucketName,
              Key: "tagging/delete.txt",
              Tagging: { TagSet: [{ Key: "ephemeral", Value: "yes" }] },
            });

            yield* getJson<{ ok: boolean }>(
              route("/delete-tagging", { key: "tagging/delete.txt" }),
            );

            // out-of-band verification via distilled
            const tags = yield* S3.getObjectTagging({
              Bucket: bucketName,
              Key: "tagging/delete.txt",
            });
            expect(tags.TagSet ?? []).toEqual([]);
          }),
        { timeout: 120_000 },
      );
    });

    describe("GetObjectAttributes", () => {
      test.provider(
        "reads object size and storage class without the body",
        (_stack) =>
          Effect.gen(function* () {
            const body = "attribute probe body";
            yield* seed("attrs/object.txt", body);

            const result = yield* getJson<{
              size: number;
              storageClass: string;
            }>(route("/attributes", { key: "attrs/object.txt" }));
            expect(result.size).toBe(body.length);
            expect(result.storageClass).toBe("STANDARD");
          }),
        { timeout: 120_000 },
      );
    });

    describe("ListObjectVersions", () => {
      test.provider(
        "lists versions under a prefix",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("versions/a.txt", "v1");

            const result = yield* getJson<{
              versions: string[];
              deleteMarkers: number;
            }>(route("/versions", { prefix: "versions/" }));
            expect(result.versions).toContain("versions/a.txt");
          }),
        { timeout: 120_000 },
      );
    });

    describe("ListParts", () => {
      test.provider(
        "lists the uploaded parts of an in-progress multipart upload",
        (_stack) =>
          Effect.gen(function* () {
            const result = yield* getJson<{
              parts: number[];
              uploads: string[];
            }>(route("/multipart-list", { key: "mpu/list.bin" }));
            expect(result.parts).toEqual([1]);
          }),
        { timeout: 120_000 },
      );
    });

    describe("ListMultipartUploads", () => {
      test.provider(
        "lists in-progress multipart uploads",
        (_stack) =>
          Effect.gen(function* () {
            const result = yield* getJson<{
              parts: number[];
              uploads: string[];
            }>(route("/multipart-list", { key: "mpu/uploads.bin" }));
            expect(result.uploads).toContain("mpu/uploads.bin");
          }),
        { timeout: 120_000 },
      );
    });

    describe("UploadPartCopy", () => {
      test.provider(
        "assembles an object from a copied part",
        (_stack) =>
          Effect.gen(function* () {
            const body = "upload part copy source payload";
            yield* seed("mpu/src.txt", body);

            const result = yield* getJson<{ etag: string | undefined }>(
              route("/multipart-copy", {
                src: "mpu/src.txt",
                dest: "mpu/dest.txt",
              }),
            );
            expect(result.etag).toBeTruthy();

            // out-of-band verification via distilled — the copy landed intact
            const head = yield* S3.headObject({
              Bucket: bucketName,
              Key: "mpu/dest.txt",
            });
            expect(head.ContentLength).toBe(body.length);
          }),
        { timeout: 120_000 },
      );
    });

    describe("RestoreObject", () => {
      test.provider(
        "restore of a STANDARD object fails with the typed InvalidObjectState",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("restore/std.txt", "not archived");

            const tag = yield* getTag(
              route("/restore", { key: "restore/std.txt" }),
            );
            // STANDARD objects are not restorable — the binding must surface
            // the *typed* platform rejection, proving IAM + wiring works.
            expect([
              "InvalidObjectState",
              "ObjectAlreadyInActiveTierError",
            ]).toContain(tag);
          }),
        { timeout: 120_000 },
      );
    });

    describe("GetObjectRetention", () => {
      test.provider(
        "returns the typed InvalidRequest on a bucket without Object Lock",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("lock/get-retention.txt", "no lock");
            const tag = yield* getTag(
              route("/retention", { key: "lock/get-retention.txt" }),
            );
            expect(tag).toBe("InvalidRequest");
          }),
        { timeout: 120_000 },
      );
    });

    describe("PutObjectRetention", () => {
      test.provider(
        "returns the typed InvalidRequest on a bucket without Object Lock",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("lock/put-retention.txt", "no lock");
            const tag = yield* getTag(
              route("/retention-put", { key: "lock/put-retention.txt" }),
            );
            expect(tag).toBe("InvalidRequest");
          }),
        { timeout: 120_000 },
      );
    });

    describe("GetObjectLegalHold", () => {
      test.provider(
        "returns the typed InvalidRequest on a bucket without Object Lock",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("lock/get-hold.txt", "no lock");
            const tag = yield* getTag(
              route("/legal-hold", { key: "lock/get-hold.txt" }),
            );
            expect(tag).toBe("InvalidRequest");
          }),
        { timeout: 120_000 },
      );
    });

    describe("PutObjectLegalHold", () => {
      test.provider(
        "returns the typed InvalidRequest on a bucket without Object Lock",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("lock/put-hold.txt", "no lock");
            const tag = yield* getTag(
              route("/legal-hold-put", { key: "lock/put-hold.txt" }),
            );
            expect(tag).toBe("InvalidRequest");
          }),
        { timeout: 120_000 },
      );
    });
  },
);
