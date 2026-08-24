import * as AWS from "@/AWS";
import { Trail } from "@/AWS/CloudTrail";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Bucket } from "@/AWS/S3/Bucket.ts";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CloudTrailTestFunctionLive, { CloudTrailTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudTrailBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx from the shared Lambda fixture (cold re-init, IAM
// propagation on the freshly attached cloudtrail policy surfaced as a 500 by
// the handler's `Effect.orDie`). Genuine 4xx/assertion failures return
// immediately.
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

const getJson = (url: string) =>
  send(HttpClientRequest.get(url)).pipe(Effect.flatMap((r) => r.json));

describe.sequential("CloudTrail Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "CloudTrail test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("CloudTrail test setup: deploying fixture");
      // EventBridge only publishes `AWS API Call via CloudTrail` events
      // while at least one trail with logging enabled exists in the region
      // — deploy one next to the fixture function. The trail ARN is
      // deterministic, so the log bucket's policy can reference it before
      // the trail exists.
      const { accountId, region } = yield* Core.withProviders(
        AWSEnvironment.current,
        testOptions,
        sharedStack.name,
      );
      const trailName = "alchemy-test-cloudtrail-bindings";
      const logBucketName = `alchemy-test-cloudtrail-bindings-logs-${accountId}`;
      const trailArn = `arn:aws:cloudtrail:${region}:${accountId}:trail/${trailName}`;
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const logBucket = yield* Bucket("BindingsTrailLogs", {
            bucketName: logBucketName,
            forceDestroy: true,
            policy: [
              {
                Effect: "Allow",
                Principal: { Service: "cloudtrail.amazonaws.com" },
                Action: ["s3:GetBucketAcl"],
                Resource: `arn:aws:s3:::${logBucketName}`,
                Condition: { StringEquals: { "aws:SourceArn": trailArn } },
              },
              {
                Effect: "Allow",
                Principal: { Service: "cloudtrail.amazonaws.com" },
                Action: ["s3:PutObject"],
                Resource: `arn:aws:s3:::${logBucketName}/AWSLogs/${accountId}/*`,
                Condition: {
                  StringEquals: {
                    "s3:x-amz-acl": "bucket-owner-full-control",
                    "aws:SourceArn": trailArn,
                  },
                },
              },
            ],
          });
          yield* Trail("BindingsTrail", {
            trailName,
            s3BucketName: logBucket.bucketName,
          });
          return yield* CloudTrailTestFunction;
        }).pipe(Effect.provide(CloudTrailTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/info`;

      yield* Effect.logInfo(
        `CloudTrail test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 240_000,
  });

  describe("LookupEvents", () => {
    test.provider("reads the 90-day management event history", () =>
      Effect.gen(function* () {
        const body = (yield* getJson(`${baseUrl}/lookup`)) as any;

        // An active test account always has recent management events.
        expect(Array.isArray(body.names)).toBe(true);
        expect(body.count).toBeGreaterThan(0);
      }),
    );
  });

  describe("ListPublicKeys", () => {
    test.provider("lists digest public keys (possibly none)", () =>
      Effect.gen(function* () {
        const body = (yield* getJson(`${baseUrl}/public-keys`)) as any;

        // Keys only exist while a log-file-validated trail has been
        // delivering digests — the call succeeding proves the IAM + binding
        // wiring either way.
        expect(Array.isArray(body.fingerprints)).toBe(true);
      }),
    );
  });

  describe("ListInsightsMetricData", () => {
    test.provider("reads an Insights metric series (empty is fine)", () =>
      Effect.gen(function* () {
        const body = (yield* getJson(`${baseUrl}/insights-metric`)) as any;

        // No Insights are enabled in the test account, so the series is
        // empty — success proves the wiring; a rejection must be TYPED.
        if (body.errorTag !== undefined) {
          expect(typeof body.errorTag).toBe("string");
          expect(body.errorTag.length).toBeGreaterThan(0);
        } else {
          expect(body.timestamps).toBeGreaterThanOrEqual(0);
          expect(body.values).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  describe("ListInsightsData", () => {
    test.provider("reads raw Insights events (empty is fine)", () =>
      Effect.gen(function* () {
        const body = (yield* getJson(`${baseUrl}/insights-data`)) as any;

        // No Insights are enabled in the test account, so the list is
        // empty — success proves the wiring; a rejection must be TYPED.
        if (body.errorTag !== undefined) {
          expect(typeof body.errorTag).toBe("string");
          expect(body.errorTag.length).toBeGreaterThan(0);
        } else {
          expect(body.events).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  describe("ApiCallEventSource", () => {
    test.provider(
      "delivers a mutating management API call to the handler",
      () =>
        Effect.gen(function* () {
          const info = (yield* getJson(`${baseUrl}/info`)) as any;
          const bucketName = info.bucketName as string;
          expect(bucketName).toBeTruthy();

          // Each probe iteration re-fires a PutBucketTagging call (riding
          // out fresh-rule propagation on the default bus), preserving the
          // bucket's existing tags, then checks for the marker the event
          // handler wrote to S3.
          const probe = Effect.gen(function* () {
            const existing = yield* s3
              .getBucketTagging({ Bucket: bucketName })
              .pipe(
                Effect.map((r) => r.TagSet ?? []),
                Effect.catchTag("NoSuchTagSet", () => Effect.succeed([])),
              );
            yield* s3.putBucketTagging({
              Bucket: bucketName,
              Tagging: {
                TagSet: [
                  ...existing.filter((t) => t.Key !== "cloudtrail-probe"),
                  { Key: "cloudtrail-probe", Value: "1" },
                ],
              },
            });
            yield* Effect.sleep("5 seconds");
            const body = (yield* getJson(
              `${baseUrl}/events/check?bucket=${bucketName}`,
            )) as any;
            return body.seen as boolean;
          });

          // A freshly created trail warms up the CloudTrail→EventBridge
          // pipeline on its first events — budget accordingly (bounded).
          const seen = yield* probe.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (s): boolean => s,
              times: 22,
            }),
          );
          expect(seen).toBe(true);
        }),
      { timeout: 300_000 },
    );
  });
});
