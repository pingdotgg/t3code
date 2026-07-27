import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CloudFrontTestFunctionLive, {
  CloudFrontTestFunction,
} from "./handler.ts";
import CloudFrontKvsTestFunctionLive, {
  CloudFrontKvsTestFunction,
} from "./kvs-handler.ts";

// The fixture deploys a CloudFront Distribution, which takes 3-10 minutes to
// reach `Deployed` — gate the live run per the catalog's slow-test guidance.
const runLive =
  process.env.AWS_TEST_SLOW === "1" ||
  process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudFrontBindings");

let baseUrl: string;

// Resolve the fixture's distribution out-of-band by its deterministic
// comment (runtime Output resolution inside the Lambda is not available for
// resources declared in the fixture, so the test looks the id up itself).
// Runs inside the test body — `beforeAll` has no distilled credentials
// context. `listDistributions` is eventually consistent for a
// freshly-created distribution, so retry the lookup for up to ~60s.
const findFixtureDistributionId = Effect.gen(function* () {
  const response = yield* cloudfront.listDistributions({});
  const match = (response.DistributionList?.Items ?? []).find(
    // Comment is a sensitive field — distilled decodes it as Redacted.
    (item) =>
      (typeof item.Comment === "string"
        ? item.Comment
        : Redacted.value(item.Comment)) === "alchemy-cf-bindings-fixture",
  );
  if (!match) {
    return yield* Effect.fail(
      new Error("fixture distribution not found by comment"),
    );
  }
  return match.Id;
}).pipe(
  Effect.retry({
    while: (e) => e instanceof Error,
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(30)]),
  }),
);

describe("CloudFront Bindings", () => {
  beforeAll(
    runLive
      ? Effect.gen(function* () {
          yield* Effect.logInfo("CloudFront bindings: destroying previous");
          yield* sharedStack.destroy();

          yield* Effect.logInfo(
            "CloudFront bindings: deploying fixture (distribution deploy is slow)",
          );
          const { functionUrl } = yield* sharedStack.deploy(
            Effect.gen(function* () {
              return yield* CloudFrontTestFunction;
            }).pipe(Effect.provide(CloudFrontTestFunctionLive)),
          );

          expect(functionUrl).toBeTruthy();
          baseUrl = functionUrl!.replace(/\/+$/, "");

          // Fresh function URLs take a few seconds to start serving.
          yield* HttpClient.get(`${baseUrl}/health`).pipe(
            Effect.flatMap((response) =>
              response.status === 200
                ? Effect.void
                : Effect.fail(
                    new Error(`Function not ready: ${response.status}`),
                  ),
            ),
            Effect.retry({
              while: (e) => e instanceof Error,
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(60),
              ]),
            }),
          );
        })
      : Effect.void,
    { timeout: 900_000 },
  );
  afterAll(runLive ? sharedStack.destroy() : Effect.void, {
    timeout: 900_000,
  });

  describe("CreateInvalidation", () => {
    test.provider.skipIf(!runLive)(
      "creates an invalidation for the bound distribution at runtime",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* HttpClient.execute(
            HttpClientRequest.post(`${baseUrl}/invalidate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                callerReference: "alchemy-test-invalidation-1",
                paths: ["/index.html"],
              }),
            ),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            invalidationId: string;
            status: string;
          };
          expect(body.invalidationId).toBeTruthy();
          expect(["InProgress", "Completed"]).toContain(body.status);

          // Out-of-band: the invalidation exists on the distribution.
          const distributionId = yield* findFixtureDistributionId;
          const observed = yield* cloudfront.getInvalidation({
            DistributionId: distributionId,
            Id: body.invalidationId,
          });
          expect(observed.Invalidation?.Id).toBe(body.invalidationId);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetInvalidation + ListInvalidations", () => {
    test.provider.skipIf(!runLive)(
      "reads and lists invalidations for the bound distribution at runtime",
      (_stack) =>
        Effect.gen(function* () {
          // Create one via the runtime binding first.
          const created = yield* HttpClient.execute(
            HttpClientRequest.post(`${baseUrl}/invalidate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                callerReference: "alchemy-test-invalidation-2",
                paths: ["/about.html"],
              }),
            ),
          );
          expect(created.status).toBe(200);
          const { invalidationId } = (yield* created.json) as {
            invalidationId: string;
          };

          // GetInvalidation reads its status through the binding.
          const got = yield* HttpClient.get(
            `${baseUrl}/invalidation?id=${invalidationId}`,
          );
          expect(got.status).toBe(200);
          const gotBody = (yield* got.json) as {
            invalidationId: string;
            status: string;
          };
          expect(gotBody.invalidationId).toBe(invalidationId);
          expect(["InProgress", "Completed"]).toContain(gotBody.status);

          // ListInvalidations includes it.
          const listed = yield* HttpClient.get(`${baseUrl}/invalidations`);
          expect(listed.status).toBe(200);
          const listedBody = (yield* listed.json) as {
            invalidationIds: string[];
          };
          expect(listedBody.invalidationIds).toContain(invalidationId);
        }),
      { timeout: 120_000 },
    );
  });
});

// The KVS fixture only needs a KeyValueStore + Lambda (no distribution), so
// it deploys in well under a minute and runs ungated.
const kvsStack = Core.scratchStack(testOptions, "CloudFrontKvsBindings");

let kvsBaseUrl: string;

// Resolve the fixture's store ARN through the deployed function's
// DescribeKeyValueStore binding (the response carries `KvsARN`), avoiding a
// paginated account-wide list lookup.
const findFixtureStoreArn = Effect.suspend(() =>
  // `kvsBaseUrl` is assigned in `beforeAll`, so build the request lazily.
  HttpClient.get(`${kvsBaseUrl}/describe`),
).pipe(
  Effect.flatMap((response) => response.json),
  Effect.map((body) => (body as { kvsArn: string }).kvsArn),
);

describe("CloudFront KeyValueStore Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* kvsStack.destroy();

      const { functionUrl } = yield* kvsStack.deploy(
        Effect.gen(function* () {
          return yield* CloudFrontKvsTestFunction;
        }).pipe(Effect.provide(CloudFrontKvsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      kvsBaseUrl = functionUrl!.replace(/\/+$/, "");

      // Fresh function URLs take a few seconds to start serving, and the
      // store's data plane can briefly 500 while the store finishes
      // provisioning + the role propagates.
      yield* HttpClient.get(`${kvsBaseUrl}/describe`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.void
            : response.text.pipe(
                Effect.flatMap((body) =>
                  Effect.fail(
                    new Error(`KVS not ready: ${response.status}: ${body}`),
                  ),
                ),
              ),
        ),
        Effect.retry({
          while: (e): boolean => e instanceof Error,
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(60),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  afterAll(kvsStack.destroy(), { timeout: 300_000 });

  describe("DescribeKeyValueStore", () => {
    test.provider(
      "reads the store's data-plane metadata at runtime",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* HttpClient.get(`${kvsBaseUrl}/describe`);
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            etag: string;
            itemCount: number;
          };
          expect(body.etag).toBeTruthy();
          expect(body.itemCount).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("PutKey + GetKey + ListKeys", () => {
    test.provider(
      "puts, gets, and lists a key at runtime",
      (_stack) =>
        Effect.gen(function* () {
          const put = yield* HttpClient.execute(
            HttpClientRequest.post(`${kvsBaseUrl}/put`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                key: "routes:/about",
                value: "/about.html",
              }),
            ),
          );
          expect(put.status).toBe(200);
          const putBody = (yield* put.json) as { etag: string };
          expect(putBody.etag).toBeTruthy();

          const got = yield* HttpClient.get(
            `${kvsBaseUrl}/key?key=${encodeURIComponent("routes:/about")}`,
          );
          expect(got.status).toBe(200);
          const gotBody = (yield* got.json) as { key: string; value: string };
          expect(gotBody.key).toBe("routes:/about");
          expect(gotBody.value).toBe("/about.html");

          const listed = yield* HttpClient.get(`${kvsBaseUrl}/keys`);
          expect(listed.status).toBe(200);
          const listedBody = (yield* listed.json) as {
            keys: { key: string; value: string }[];
          };
          expect(listedBody.keys.map((k) => k.key)).toContain("routes:/about");

          // Out-of-band: the key is visible through distilled directly.
          // KVS data-plane calls only accept us-east-1 signatures (see
          // `common.ts`), so pin the Region like the resource providers do.
          const storeArn = yield* findFixtureStoreArn;
          const observed = yield* kvs
            .getKey({
              KvsARN: storeArn,
              Key: "routes:/about",
            })
            .pipe(
              Effect.provideService(AwsRegion, Effect.succeed("us-east-1")),
            );
          expect(
            typeof observed.Value === "string"
              ? observed.Value
              : Redacted.value(observed.Value),
          ).toBe("/about.html");
        }),
      { timeout: 60_000 },
    );
  });

  describe("UpdateKeys + DeleteKey", () => {
    test.provider(
      "batch-updates and deletes keys at runtime",
      (_stack) =>
        Effect.gen(function* () {
          const updated = yield* HttpClient.execute(
            HttpClientRequest.post(`${kvsBaseUrl}/update`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                puts: [
                  { key: "routes:/", value: "/index.html" },
                  { key: "routes:/tmp", value: "/tmp.html" },
                ],
              }),
            ),
          );
          expect(updated.status).toBe(200);

          const deleted = yield* HttpClient.execute(
            HttpClientRequest.post(`${kvsBaseUrl}/delete`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ key: "routes:/tmp" }),
            ),
          );
          expect(deleted.status).toBe(200);

          const listed = yield* HttpClient.get(`${kvsBaseUrl}/keys`);
          expect(listed.status).toBe(200);
          const listedBody = (yield* listed.json) as {
            keys: { key: string; value: string }[];
          };
          const keys = listedBody.keys.map((k) => k.key);
          expect(keys).toContain("routes:/");
          expect(keys).not.toContain("routes:/tmp");
        }),
      { timeout: 60_000 },
    );
  });
});
