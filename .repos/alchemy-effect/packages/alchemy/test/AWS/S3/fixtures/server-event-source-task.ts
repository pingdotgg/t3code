import * as AWS from "@/AWS";
import { S3BucketEventSource } from "@/Server/S3BucketEventSource.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export const INCOMING_PREFIX = "incoming/";
export const INCOMING_SUFFIX = ".txt";
export const PROCESSED_PREFIX = "processed/";
export const RECEIVED_PREFIX = "deliveries/received/";
export const ACKNOWLEDGED_PREFIX = "deliveries/acknowledged/";

export const ServerEventBucket = AWS.S3.Bucket("ServerEventBucket", {
  versioning: "Enabled",
  forceDestroy: true,
});

export const artifactKey = (
  key: string,
  eventName: string,
  versionId: string,
) =>
  `${PROCESSED_PREFIX}${[key, eventName, versionId].map(encodeURIComponent).join("/")}.txt`;

// Preserve the wire body for replay without competing with the ECS consumer.
const observedReceiveMessage = Layer.effect(
  AWS.SQS.ReceiveMessage,
  Effect.gen(function* () {
    const receiveMessage = yield* AWS.SQS.ReceiveMessage;
    const bucket = yield* ServerEventBucket;
    const putObject = yield* AWS.S3.PutObject(bucket);
    return Effect.fn(function* (queue: AWS.SQS.Queue) {
      const receive = yield* receiveMessage(queue);
      return Effect.fn(function* (request: AWS.SQS.ReceiveMessageRequest) {
        const result = yield* receive(request);
        yield* Effect.forEach(result.Messages ?? [], (message) =>
          putObject({
            Key: `${RECEIVED_PREFIX}${message.MessageId!}.json`,
            Body: message.Body!,
            ContentType: "application/json",
          }).pipe(Effect.orDie),
        );
        return result;
      });
    });
  }),
).pipe(Layer.provide(AWS.SQS.ReceiveMessageHttp));

// The server acknowledges a batch only after the S3 handler completes.
const observedDeleteMessageBatch = Layer.effect(
  AWS.SQS.DeleteMessageBatch,
  Effect.gen(function* () {
    const deleteMessageBatch = yield* AWS.SQS.DeleteMessageBatch;
    const bucket = yield* ServerEventBucket;
    const putObject = yield* AWS.S3.PutObject(bucket);
    return Effect.fn(function* (queue: AWS.SQS.Queue) {
      const remove = yield* deleteMessageBatch(queue);
      return Effect.fn(function* (request: AWS.SQS.DeleteMessageBatchRequest) {
        const result = yield* remove(request);
        yield* Effect.forEach(result.Successful ?? [], (entry) =>
          putObject({
            Key: `${ACKNOWLEDGED_PREFIX}${entry.Id}.json`,
            Body: "{}",
            ContentType: "application/json",
          }).pipe(Effect.orDie),
        );
        return result;
      });
    });
  }),
).pipe(Layer.provide(AWS.SQS.DeleteMessageBatchHttp));

const serverEvents = S3BucketEventSource.pipe(
  Layer.provide(
    Layer.mergeAll(observedReceiveMessage, observedDeleteMessageBatch).pipe(
      Layer.provide(AWS.S3.PutObjectHttp),
    ),
  ),
);

export default class ServerEventTask extends AWS.ECS.Task<ServerEventTask>()(
  "S3ServerEventTask",
  {
    main: import.meta.filename,
    image: "oven/bun:1",
    cpu: 256,
    memory: 512,
    container: {
      linuxParameters: { initProcessEnabled: true },
      stopTimeout: 2,
    },
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
  },
  Effect.gen(function* () {
    const bucket = yield* ServerEventBucket;
    const getObject = yield* AWS.S3.GetObject(bucket);
    const putObject = yield* AWS.S3.PutObject(bucket);

    yield* AWS.S3.consumeBucketEvents(
      bucket,
      {
        events: ["s3:ObjectCreated:*", "s3:ObjectRemoved:*"],
        prefix: INCOMING_PREFIX,
        suffix: INCOMING_SUFFIX,
      },
      (events) =>
        events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              const versionId = event.versionId;
              if (!versionId) {
                return yield* Effect.fail(
                  new Error("Versioned S3 event omitted versionId"),
                );
              }
              const key = yield* Effect.sync(() =>
                artifactKey(event.key, event.type, versionId),
              );
              // Redelivery can arrive after the source version was deleted.
              const recorded = yield* getObject({ Key: key }).pipe(
                Effect.flatMap(({ Body }) => Stream.runDrain(Body!)),
                Effect.as(true),
                Effect.catchTag("NoSuchKey", () => Effect.succeed(false)),
              );
              if (recorded) return;
              const object = event.type.startsWith("s3:ObjectCreated:")
                ? yield* getObject({ Key: event.key, VersionId: versionId })
                : undefined;
              const content = object
                ? yield* Stream.mkString(Stream.decodeText(object.Body!))
                : undefined;
              const body = yield* Effect.sync(() =>
                JSON.stringify({
                  bucket: event.bucket,
                  key: event.key,
                  eventName: event.type,
                  versionId,
                  sequencer: event.sequencer,
                  size: event.size,
                  eTag: event.eTag,
                  content,
                  readVersionId: object?.VersionId,
                }),
              );
              // The suffix still matches; only the prefix prevents recursion.
              yield* putObject({
                Key: key,
                Body: body,
                ContentType: "application/json",
              });
            }).pipe(Effect.orDie),
          ),
        ),
    );

    return { run: Effect.never };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(serverEvents, AWS.S3.GetObjectHttp, AWS.S3.PutObjectHttp),
    ),
  ),
) {}
