import * as AWS from "@/AWS";
import * as Alchemy from "@/index.ts";
import * as State from "@/State";
import * as Test from "@/Test/Alchemy";
import * as Firehose from "@distilled.cloud/aws/firehose";
import * as S3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import FirehoseApiFunctionLive, {
  BucketAndDeliveryStream,
  FirehoseApiFunction,
} from "./handler.ts";

const providers = AWS.providers();
const state = State.localState();
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state,
});

const Stack = Alchemy.Stack(
  "firehose-bindings",
  { providers, state },
  Effect.gen(function* () {
    // Share the bucket/delivery-stream between the deployed function and the
    // stack outputs so the test can verify ingest out-of-band via distilled.
    const { bucket, deliveryStream } = yield* BucketAndDeliveryStream;
    const fn = yield* FirehoseApiFunction;
    return {
      url: fn.functionUrl.as<string>(),
      deliveryStreamName: deliveryStream.deliveryStreamName.as<string>(),
      bucketName: bucket.bucketName.as<string>(),
    };
  }).pipe(Effect.provide(FirehoseApiFunctionLive)),
);

const stack = beforeAll(
  Effect.gen(function* () {
    // A prior interrupted run may leave local state pointing at a partially
    // deleted Lambda/IAM fixture. Start from a clean stack; provider deletes
    // are idempotent, and deploy then proves stale-state recovery as well.
    yield* destroy(Stack);
    return yield* deploy(Stack);
  }),
  { timeout: 240_000 },
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 120_000 });

// Lambda Function URLs cold-start (DNS, init) and a fresh role's IAM grants
// (eventual consistency) can both take a while on the first hit. Retrying on
// any non-200 lets the first request wait through that window; warm calls
// return on the first try and never retry.
const readinessSchedule = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

const urlOf = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, "")}${path}`;

const getJson = (baseUrl: string, path: string) =>
  HttpClient.execute(HttpClientRequest.get(urlOf(baseUrl, path))).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`Request failed: ${response.status}`)),
    ),
    Effect.retry({ schedule: readinessSchedule }),
  );

const postJson = (baseUrl: string, path: string, body: unknown) =>
  HttpClient.execute(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(urlOf(baseUrl, path)),
      body,
    ),
  ).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`Request failed: ${response.status}`)),
    ),
    Effect.retry({ schedule: readinessSchedule }),
  );

describe("Firehose Bindings", () => {
  describe("PutRecord", () => {
    // `test.provider` supplies the AWS environment for the out-of-band
    // describeDeliveryStream verification via distilled.
    test.provider("writes a single record and the stream stays ACTIVE", () =>
      Effect.gen(function* () {
        const { url, deliveryStreamName } = yield* stack;
        const response = yield* postJson(url, "/put-record", {
          data: `put-record-${crypto.randomUUID()}`,
        });
        expect((response as any).RecordId).toBeTruthy();

        // Ingest success is the assertion — S3 delivery is asynchronous
        // (buffering ≥ 60s), so verify the stream is ACTIVE out-of-band
        // instead of waiting for objects to land.
        const described = yield* Firehose.describeDeliveryStream({
          DeliveryStreamName: deliveryStreamName,
        });
        expect(
          described.DeliveryStreamDescription.DeliveryStreamStatus,
        ).toEqual("ACTIVE");
      }),
    );
  });

  describe("PutRecordBatch", () => {
    test(
      "writes a batch of records with zero failures",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const response = yield* postJson(url, "/put-record-batch", {
          records: [
            `batch-1-${crypto.randomUUID()}`,
            `batch-2-${crypto.randomUUID()}`,
            `batch-3-${crypto.randomUUID()}`,
          ],
        });
        expect((response as any).FailedPutCount).toBe(0);
        const entries = (response as any).RequestResponses ?? [];
        expect(entries.length).toBe(3);
        for (const entry of entries) {
          expect(entry.RecordId).toBeTruthy();
          expect(entry.ErrorCode).toBeUndefined();
        }
      }),
    );
  });

  describe("ListDeliveryStreams", () => {
    test(
      "lists delivery streams and includes the fixture stream",
      Effect.gen(function* () {
        const { url, deliveryStreamName } = yield* stack;
        const response = (yield* getJson(url, "/list-streams")) as {
          DeliveryStreamNames: string[];
          HasMoreDeliveryStreams: boolean;
        };
        expect(Array.isArray(response.DeliveryStreamNames)).toBe(true);
        expect(response.DeliveryStreamNames).toContain(deliveryStreamName);
      }),
    );
  });

  describe("DeliveryStreamSink", () => {
    // `test.provider` supplies the AWS environment for the out-of-band
    // describeDeliveryStream verification via distilled.
    test.provider("streams records through the sink helper", () =>
      Effect.gen(function* () {
        const { url, deliveryStreamName } = yield* stack;
        const response = yield* postJson(url, "/sink", {
          records: [
            `sink-1-${crypto.randomUUID()}`,
            `sink-2-${crypto.randomUUID()}`,
            `sink-3-${crypto.randomUUID()}`,
          ],
        });
        expect((response as any).ok).toBe(true);
        expect((response as any).count).toBe(3);

        // Ingest success is the assertion — S3 delivery is asynchronous
        // (buffering ≥ 60s; see the gated slow test below for arrival proof).
        const described = yield* Firehose.describeDeliveryStream({
          DeliveryStreamName: deliveryStreamName,
        });
        expect(
          described.DeliveryStreamDescription.DeliveryStreamStatus,
        ).toEqual("ACTIVE");
      }),
    );

    test(
      "splits more than 500 records into multiple PutRecordBatch calls",
      Effect.gen(function* () {
        const { url } = yield* stack;
        // 501 records > the PutRecordBatch limit of 500, so the batched sink
        // must split the chunk into 2 sequential API calls (500 + 1). Any
        // per-record ServiceUnavailable failures are retried by the sink
        // engine before the handler responds.
        const marker = crypto.randomUUID();
        const response = yield* postJson(url, "/sink", {
          records: Array.from({ length: 501 }, (_, i) => `sink-${marker}-${i}`),
        });
        expect((response as any).ok).toBe(true);
        expect((response as any).count).toBe(501);
      }),
      { timeout: 120_000 },
    );
  });

  // Even with zero buffering, Firehose treats the interval and size as hints
  // and has exceeded the default suite's 90-second platform budget in live
  // runs. Keep the end-to-end proof opt-in, but run its independent checks
  // concurrently so they share one bounded delivery window.
  describe.concurrent.skipIf(!process.env.AWS_TEST_SLOW)(
    "S3 delivery (slow)",
    () => {
      class MarkerNotDeliveredYet extends Data.TaggedError(
        "MarkerNotDeliveredYet",
      ) {}

      const waitForMarker = (bucketName: string, marker: string) => {
        const findMarker = Effect.gen(function* () {
          const listing = yield* S3.listObjectsV2({
            Bucket: bucketName,
            Prefix: "records/",
          });
          for (const object of listing.Contents ?? []) {
            if (object.Key === undefined) {
              continue;
            }
            const got = yield* S3.getObject({
              Bucket: bucketName,
              Key: object.Key,
            });
            // The body read surfaces plain `Error` (streaming transport) — a
            // mid-delivery read hiccup is just "not delivered yet".
            const text = yield* Stream.mkString(
              Stream.decodeText(got.Body!),
            ).pipe(
              Effect.catch(() => Effect.fail(new MarkerNotDeliveredYet())),
            );
            if (text.includes(marker)) {
              return object.Key;
            }
          }
          return yield* new MarkerNotDeliveredYet();
        });

        return findMarker.pipe(
          Effect.retry({
            while: (e) => e._tag === "MarkerNotDeliveredYet",
            schedule: Schedule.max([
              Schedule.fixed("10 seconds"),
              Schedule.recurs(12),
            ]),
          }),
        );
      };

      test.provider(
        "delivers buffered records to the destination bucket",
        () =>
          Effect.gen(function* () {
            const { url, bucketName } = yield* stack;
            // Randomness is only a payload correlation marker, never a
            // physical resource name. It prevents a prior run's object from
            // satisfying this delivery proof.
            const marker = `put-record-delivery-${crypto.randomUUID()}`;
            yield* postJson(url, "/put-record", {
              data: marker,
            });
            expect(yield* waitForMarker(bucketName, marker)).toBeTruthy();
          }),
        { timeout: 180_000 },
      );

      test.provider(
        "sink records land in the destination bucket (marker-anchored)",
        () =>
          Effect.gen(function* () {
            const { url, bucketName } = yield* stack;
            const marker = `sink-delivery-${crypto.randomUUID()}`;
            yield* postJson(url, "/sink", {
              records: [`${marker}-1`, `${marker}-2`],
            });
            expect(yield* waitForMarker(bucketName, marker)).toBeTruthy();
          }),
        { timeout: 180_000 },
      );
    },
  );
});
