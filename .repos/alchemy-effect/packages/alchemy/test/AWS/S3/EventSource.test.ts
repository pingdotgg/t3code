import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
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
import BucketEventSourceFunctionLive, {
  BucketEventSourceFunction,
} from "./fixtures/event-source-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "S3EventSource",
  "test/AWS/S3/EventSource.test.ts",
);

const readinessPolicy = Schedule.spaced("2 seconds");

let baseUrl: string;
let fixtureFunctionName: string;
let fixtureBucketName: string | undefined;

describe(
  "S3 Bucket Event Source",
  { tags: ["provider:aws", "provider:aws:lambda", "provider:aws:s3", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* Effect.logInfo(
          "S3 EventSource test: destroying previous resources",
        );
        yield* sharedStack.destroy();

        yield* Effect.logInfo("S3 EventSource test: deploying fixture");
        const { functionUrl, functionName } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return yield* BucketEventSourceFunction;
          }).pipe(Effect.provide(BucketEventSourceFunctionLive)),
        );

        expect(functionUrl).toBeTruthy();
        baseUrl = functionUrl!.replace(/\/+$/, "");
        fixtureFunctionName = functionName;

        yield* Effect.logInfo(
          `S3 EventSource test: function URL ready (${functionUrl}), probing readiness`,
        );

        const named = yield* HttpClient.get(`${baseUrl}/bucket-name`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : response.text.pipe(
                  Effect.flatMap((body) =>
                    Effect.fail(
                      new FunctionNotReady({ status: response.status, body }),
                    ),
                  ),
                ),
          ),
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({ bucketName: Schema.String }),
            ),
          ),
          Effect.tapError((error) =>
            Effect.logWarning(
              `S3 EventSource test: fixture not ready yet (${String(error)})`,
            ),
          ),
          Effect.retry({ schedule: readinessPolicy, times: 9 }),
        );
        fixtureBucketName = named.bucketName;
        expect(fixtureBucketName).toBeTruthy();
        yield* Effect.logInfo(
          "S3 EventSource test: fixture responded successfully",
        );
      }),
      { timeout: 120_000 },
    );

    afterAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        // Prove the trailing destroy removed the fixture bucket (skip if
        // setup never captured the name). afterAll lacks the providers layer
        // test bodies get, so provide it for the out-of-band distilled call.
        if (fixtureBucketName) {
          yield* Core.withProviders(
            assertBucketDeleted(fixtureBucketName),
            testOptions,
            "S3EventSource",
          );
        }
      }),
      { timeout: 120_000 },
    );

    test.provider(
      "object created under the watched prefix triggers the subscription to write derived state",
      (_stack) =>
        Effect.gen(function* () {
          const key = "e2e-object";

          const content = "hello from s3 event source";
          const response = yield* HttpClient.execute(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/put`),
              { key, value: content },
            ),
          );
          expect(response.status).toBe(200);
          const putResponse = yield* response.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ ok: Schema.Boolean, versionId: Schema.String }),
              ),
            ),
          );
          expect(putResponse.ok).toBe(true);
          expect(putResponse.versionId).toBeTruthy();
          const processed = yield* waitForProcessed({
            key: `incoming/${key}`,
            eventName: "s3:ObjectCreated:Put",
            versionId: putResponse.versionId,
          });
          expect(processed.size).toBe(content.length);
          expect(processed.eTag).toBeTruthy();
          expect(processed.content).toBe(content);
          expect(processed.readVersionId).toBe(putResponse.versionId);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "preserves both PUT versions and records delete-marker and explicit-version removal events",
      () =>
        Effect.gen(function* () {
          const Bucket = fixtureBucketName!;
          const key = "incoming/versions/a b+%?#/雪.txt";
          const oldContent = "historical notification content";
          const currentContent =
            "current notification content has different bytes";
          const oldVersion = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: oldContent,
          });
          const currentVersion = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: currentContent,
          });
          expect(oldVersion.VersionId).toBeTruthy();
          expect(currentVersion.VersionId).toBeTruthy();
          expect(currentVersion.VersionId).not.toBe(oldVersion.VersionId);
          const oldIdentity = {
            key,
            eventName: "s3:ObjectCreated:Put",
            versionId: oldVersion.VersionId!,
          };
          const currentIdentity = {
            key,
            eventName: "s3:ObjectCreated:Put",
            versionId: currentVersion.VersionId!,
          };
          const [oldEvent, currentEvent] = yield* Effect.all(
            [waitForProcessed(oldIdentity), waitForProcessed(currentIdentity)],
            { concurrency: 2 },
          );
          expect(oldEvent.content).toBe(oldContent);
          expect(oldEvent.size).toBe(oldContent.length);
          expect(oldEvent.readVersionId).toBe(oldVersion.VersionId);
          expect(currentEvent.content).toBe(currentContent);
          expect(currentEvent.size).toBe(currentContent.length);
          expect(currentEvent.readVersionId).toBe(currentVersion.VersionId);
          expect(oldEvent.sequencer).not.toBe(currentEvent.sequencer);

          const marker = yield* S3.deleteObject({ Bucket, Key: key });
          expect(marker.DeleteMarker).toBe(true);
          expect(marker.VersionId).toBeTruthy();
          expect(marker.VersionId).not.toBe(oldVersion.VersionId);
          expect(marker.VersionId).not.toBe(currentVersion.VersionId);
          const removed = yield* S3.deleteObject({
            Bucket,
            Key: key,
            VersionId: oldVersion.VersionId!,
          });
          expect(removed.VersionId).toBe(oldVersion.VersionId);
          const [markerEvent, removedEvent] = yield* Effect.all(
            [
              waitForProcessed({
                key,
                eventName: "s3:ObjectRemoved:DeleteMarkerCreated",
                versionId: marker.VersionId!,
              }),
              waitForProcessed({
                key,
                eventName: "s3:ObjectRemoved:Delete",
                versionId: removed.VersionId!,
              }),
            ],
            { concurrency: 2 },
          );
          for (const event of [markerEvent, removedEvent]) {
            expect(event.content).toBeUndefined();
            expect(event.readVersionId).toBeUndefined();
          }

          // Removal records must not replace the earlier creation histories.
          expect(yield* readProcessed(oldIdentity)).toEqual(oldEvent);
          expect(yield* readProcessed(currentIdentity)).toEqual(currentEvent);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "replays a creation event through the deployed Lambda after permanent source-version deletion",
      () =>
        Effect.gen(function* () {
          const Bucket = fixtureBucketName!;
          const key = "incoming/replay/a b+%?#/雪.txt";
          const content = "recorded before permanent version deletion";
          const created = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: content,
          });
          expect(created.VersionId).toBeTruthy();
          const identity = {
            key,
            eventName: "s3:ObjectCreated:Put",
            versionId: created.VersionId!,
          };
          const recorded = yield* waitForProcessed(identity);
          expect(recorded.content).toBe(content);
          expect(recorded.readVersionId).toBe(created.VersionId);
          const evidenceKey = yield* Effect.sync(
            () =>
              `processed/${[key, identity.eventName, identity.versionId].map(encodeURIComponent).join("/")}.json`,
          );
          const before = yield* S3.headObject({ Bucket, Key: evidenceKey });
          expect(before.VersionId).toBeTruthy();

          yield* S3.deleteObject({
            Bucket,
            Key: key,
            VersionId: identity.versionId,
          });
          const sourceExists = yield* S3.headObject({
            Bucket,
            Key: key,
            VersionId: identity.versionId,
          }).pipe(
            Effect.as(true),
            Effect.catchTag("NotFound", () => Effect.succeed(false)),
          );
          expect(sourceExists).toBe(false);

          const region = yield* AWS.Region;
          const Payload = yield* Effect.sync(() =>
            JSON.stringify({
              Records: [
                {
                  eventVersion: "2.1",
                  eventSource: "aws:s3",
                  awsRegion: region,
                  eventName: "ObjectCreated:Put",
                  s3: {
                    s3SchemaVersion: "1.0",
                    bucket: { name: Bucket, arn: `arn:aws:s3:::${Bucket}` },
                    object: {
                      key: encodeURIComponent(key).replace(/%20/g, "+"),
                      versionId: identity.versionId,
                      sequencer: recorded.sequencer,
                      size: recorded.size,
                      eTag: recorded.eTag,
                    },
                  },
                },
              ],
            }),
          );
          const replay = yield* Lambda.invoke({
            FunctionName: fixtureFunctionName,
            InvocationType: "RequestResponse",
            Payload,
          });
          if (replay.Payload) yield* Stream.runDrain(replay.Payload);
          expect(replay.StatusCode).toBe(200);
          expect(replay.FunctionError).toBeUndefined();
          expect(yield* readProcessed(identity)).toEqual(recorded);
          const after = yield* S3.headObject({ Bucket, Key: evidenceKey });
          expect(after.VersionId).toBe(before.VersionId);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "records a copied version and reads its historical content after a later PUT",
      () =>
        Effect.gen(function* () {
          const Bucket = fixtureBucketName!;
          const sourceKey = "sources/copy.txt";
          const key = "incoming/copied/a b+%.txt";
          const content = "historical copy source content";
          const source = yield* S3.putObject({
            Bucket,
            Key: sourceKey,
            Body: content,
          });
          expect(source.VersionId).toBeTruthy();
          yield* S3.putObject({
            Bucket,
            Key: sourceKey,
            Body: "new source content must not be copied",
          });
          const CopySource = yield* Effect.sync(
            () =>
              `${Bucket}/${sourceKey}?versionId=${encodeURIComponent(source.VersionId!)}`,
          );
          const copied = yield* S3.copyObject({
            Bucket,
            Key: key,
            CopySource,
          });
          expect(copied.VersionId).toBeTruthy();
          expect(copied.CopySourceVersionId).toBe(source.VersionId);
          const latestContent = "later destination content";
          const latest = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: latestContent,
          });
          expect(latest.VersionId).toBeTruthy();
          expect(latest.VersionId).not.toBe(copied.VersionId);
          const [copyEvent, putEvent] = yield* Effect.all(
            [
              waitForProcessed({
                key,
                eventName: "s3:ObjectCreated:Copy",
                versionId: copied.VersionId!,
              }),
              waitForProcessed({
                key,
                eventName: "s3:ObjectCreated:Put",
                versionId: latest.VersionId!,
              }),
            ],
            { concurrency: 2 },
          );
          expect(copyEvent.content).toBe(content);
          expect(copyEvent.size).toBe(content.length);
          expect(copyEvent.eTag).toBeTruthy();
          expect(copyEvent.readVersionId).toBe(copied.VersionId);
          expect(putEvent.content).toBe(latestContent);
          expect(putEvent.readVersionId).toBe(latest.VersionId);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "records a completed multipart version and reads its content after a later PUT",
      () =>
        Effect.gen(function* () {
          const Bucket = fixtureBucketName!;
          const key = "incoming/multipart/a b+%.txt";
          const content = "single final multipart part";
          const upload = yield* S3.createMultipartUpload({ Bucket, Key: key });
          expect(upload.UploadId).toBeTruthy();
          const part = yield* S3.uploadPart({
            Bucket,
            Key: key,
            UploadId: upload.UploadId!,
            PartNumber: 1,
            Body: content,
          });
          expect(part.ETag).toBeTruthy();
          const completed = yield* S3.completeMultipartUpload({
            Bucket,
            Key: key,
            UploadId: upload.UploadId!,
            MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag! }] },
          });
          expect(completed.VersionId).toBeTruthy();
          const latestContent = "later multipart destination content";
          const latest = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: latestContent,
          });
          expect(latest.VersionId).toBeTruthy();
          expect(latest.VersionId).not.toBe(completed.VersionId);
          const [completedEvent, putEvent] = yield* Effect.all(
            [
              waitForProcessed({
                key,
                eventName: "s3:ObjectCreated:CompleteMultipartUpload",
                versionId: completed.VersionId!,
              }),
              waitForProcessed({
                key,
                eventName: "s3:ObjectCreated:Put",
                versionId: latest.VersionId!,
              }),
            ],
            { concurrency: 2 },
          );
          expect(completedEvent.content).toBe(content);
          expect(completedEvent.size).toBe(content.length);
          expect(completedEvent.eTag).toBeTruthy();
          expect(completedEvent.readVersionId).toBe(completed.VersionId);
          expect(putEvent.content).toBe(latestContent);
          expect(putEvent.readVersionId).toBe(latest.VersionId);
        }),
      { timeout: 120_000 },
    );
  },
);

interface NotificationIdentity {
  key: string;
  eventName: string;
  versionId: string;
}

const processedRecord = Schema.Struct({
  bucket: Schema.String,
  key: Schema.String,
  eventName: Schema.String,
  versionId: Schema.String,
  sequencer: Schema.String,
  size: Schema.optional(Schema.Number),
  eTag: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  readVersionId: Schema.optional(Schema.String),
});

const readProcessed = Effect.fn(function* (identity: NotificationIdentity) {
  const path = yield* Effect.sync(
    () => `/processed?${new URLSearchParams({ ...identity })}`,
  );
  const response = yield* HttpClient.get(`${baseUrl}${path}`);
  if (response.status === 404) {
    yield* response.text;
    return yield* Effect.fail(new ProcessedNotReady(identity));
  }
  if (response.status !== 200) {
    return yield* Effect.fail(
      new FunctionNotReady({
        status: response.status,
        body: yield* response.text,
      }),
    );
  }
  const { processed } = yield* response.json.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.Struct({ processed: processedRecord })),
    ),
  );
  expect(processed.bucket).toBe(fixtureBucketName);
  expect(processed.key).toBe(identity.key);
  expect(processed.eventName).toBe(identity.eventName);
  expect(processed.versionId).toBe(identity.versionId);
  expect(processed.sequencer).toMatch(/^[0-9a-f]+$/i);
  return processed;
});

const waitForProcessed = (identity: NotificationIdentity) =>
  readProcessed(identity).pipe(
    Effect.retry({
      while: (error) => error._tag === "ProcessedNotReady",
      schedule: Schedule.spaced("5 seconds"),
      times: 9,
    }),
  );

class ProcessedNotReady extends Data.TaggedError(
  "ProcessedNotReady",
)<NotificationIdentity> {}

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

// Out-of-band assert-gone after the final destroy: retry while headBucket
// still succeeds (S3 delete visibility is eventually consistent), settle on
// the typed NotFound.
const assertBucketDeleted = Effect.fn(function* (name: string) {
  yield* S3.headBucket({ Bucket: name }).pipe(
    Effect.flatMap(() => Effect.fail(new BucketStillExists())),
    Effect.retry({
      while: (e) => e._tag === "BucketStillExists",
      schedule: Schedule.spaced("5 seconds"),
      times: 9,
    }),
    Effect.catchTag("NotFound", () => Effect.void),
  );
});

class FunctionNotReady extends Data.TaggedError("FunctionNotReady")<{
  readonly status: number;
  readonly body: string;
}> {}
