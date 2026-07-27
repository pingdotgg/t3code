import * as CloudTrail from "@/AWS/CloudTrail";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Probe helper: run the bound operation and report either the success
 * projection or the typed error tag, so the test can assert that operations
 * rejected by CloudTrail fail with a TYPED tag (never an untyped catch-all).
 */
const tagOr = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
  onSuccess: (value: A) => Record<string, unknown>,
) =>
  Effect.result(effect).pipe(
    Effect.map((result) =>
      Result.isSuccess(result)
        ? onSuccess(result.success)
        : { errorTag: result.failure._tag },
    ),
  );

export class CloudTrailTestFunction extends Lambda.Function<Lambda.Function>()(
  "CloudTrailTestFunction",
) {}

export default CloudTrailTestFunction.make(
  {
    main,
    url: true,
    // LookupEvents scans + distilled's bounded retries must complete within
    // the invocation; AWS's 3s default would intermittently time out.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Holds the event-source markers (under events/).
    const bucket = yield* S3.Bucket("CloudTrailEvents", {
      forceDestroy: true,
    });
    const BucketName = yield* bucket.bucketName;

    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);

    // --- account-level bindings ---
    const lookupEvents = yield* CloudTrail.LookupEvents();
    const listPublicKeys = yield* CloudTrail.ListPublicKeys();
    const listInsightsMetricData = yield* CloudTrail.ListInsightsMetricData();
    const listInsightsData = yield* CloudTrail.ListInsightsData();

    // --- event source ---
    // EventBridge receives every mutating management API call CloudTrail
    // records; write a marker object per PutBucketTagging call so
    // /events/check can observe the delivery out-of-band (the event may
    // arrive on another instance).
    yield* CloudTrail.consumeApiCallEvents(
      {
        eventSources: ["s3.amazonaws.com"],
        eventNames: ["PutBucketTagging"],
      },
      (events) =>
        Stream.runForEach(events, (event) =>
          putObject({
            Key: `events/${event.detail.requestParameters?.bucketName}`,
            Body: JSON.stringify({
              eventName: event.detail.eventName,
              eventSource: event.detail.eventSource,
              eventID: event.detail.eventID,
            }),
            ContentType: "application/json",
          }).pipe(Effect.orDie, Effect.asVoid),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const param = (name: string) => url.searchParams.get(name) ?? "";

        // Report the fixture bucket so the test can tag it out-of-band.
        if (request.method === "GET" && pathname === "/info") {
          return yield* HttpServerResponse.json({
            bucketName: yield* BucketName,
          });
        }

        // 90-day management event history — always available, no trail
        // needed. Mutating calls always exist in an active test account.
        if (request.method === "GET" && pathname === "/lookup") {
          const result = yield* lookupEvents({ MaxResults: 5 });
          return yield* HttpServerResponse.json({
            count: (result.Events ?? []).length,
            names: (result.Events ?? []).map((e) => e.EventName),
          });
        }

        if (request.method === "GET" && pathname === "/public-keys") {
          const result = yield* listPublicKeys();
          return yield* HttpServerResponse.json({
            fingerprints: (result.PublicKeyList ?? []).map(
              (k) => k.Fingerprint,
            ),
          });
        }

        // Insights metrics read; empty series when Insights has recorded no
        // anomalies. A rejection must surface as a TYPED tag.
        if (request.method === "GET" && pathname === "/insights-metric") {
          return yield* HttpServerResponse.json(
            yield* tagOr(
              listInsightsMetricData({
                EventSource: "s3.amazonaws.com",
                EventName: "PutObject",
                InsightType: "ApiCallRateInsight",
                MaxResults: 5,
              }),
              (result) => ({
                timestamps: (result.Timestamps ?? []).length,
                values: (result.Values ?? []).length,
              }),
            ),
          );
        }

        // Raw Insights events read; empty when Insights has recorded no
        // anomalies (none are enabled in the test account). A rejection must
        // surface as a TYPED tag.
        if (request.method === "GET" && pathname === "/insights-data") {
          return yield* HttpServerResponse.json(
            yield* tagOr(
              listInsightsData({
                InsightSource: "s3.amazonaws.com",
                DataType: "InsightsEvents",
                MaxResults: 5,
              }),
              (result) => ({ events: (result.Events ?? []).length }),
            ),
          );
        }

        // Has the API-call event for this bucket been delivered yet?
        if (request.method === "GET" && pathname === "/events/check") {
          const seen = yield* getObject({
            Key: `events/${param("bucket")}`,
          }).pipe(
            Effect.map(() => true),
            Effect.catchTag("NoSuchKey", () => Effect.succeed(false)),
          );
          return yield* HttpServerResponse.json({ seen });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        CloudTrail.LookupEventsHttp,
        CloudTrail.ListPublicKeysHttp,
        CloudTrail.ListInsightsMetricDataHttp,
        CloudTrail.ListInsightsDataHttp,
        S3.PutObjectHttp,
        S3.GetObjectHttp,
      ),
    ),
  ),
);
