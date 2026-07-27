import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Bucket } from "../AWS/S3/Bucket.ts";
import type {
  BucketNotification,
  NotificationsProps,
} from "../AWS/S3/BucketNotifications.ts";
import * as S3 from "../AWS/S3/index.ts";
import type { S3EventType } from "../AWS/S3/S3Event.ts";
import * as SQS from "../AWS/SQS/index.ts";
import { SQSQueueEventSource } from "./SQSQueueEventSource.ts";

/** @binding */
export const S3BucketEventSource = Layer.effect(
  S3.BucketEventSource,
  Effect.gen(function* () {
    const Queue = yield* SQS.Queue;

    return Effect.fn(function* <
      Events extends S3EventType[],
      StreamReq = never,
      Req = never,
    >(
      bucket: Bucket,
      props: NotificationsProps<Events>,
      process: (
        stream: Stream.Stream<BucketNotification, never, StreamReq>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      const queue = yield* Queue(`${bucket.LogicalId}-BucketEvents`);

      // Deploy-time: grant the bucket sqs:SendMessage on the queue and attach the
      // bucket's notification config. Skipped once running inside the deployed
      // Function (the global guard); the runtime only registers the consumer below.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const events = props.events ?? ["s3:ObjectCreated:*"];
        yield* queue.bind(`AWS.SQS.SendMessage(${bucket.LogicalId})`, {
          policyStatements: [
            {
              Sid: `AllowS3EventsFrom${bucket.LogicalId}`,
              Effect: "Allow",
              Action: ["sqs:SendMessage"],
              Resource: [queue.queueArn],
              Condition: {
                ArnEquals: {
                  "aws:SourceArn": bucket.bucketArn,
                },
              },
            },
          ],
        });
        yield* bucket.bind(
          `AWS.S3.NotificationConfiguration(${queue.LogicalId})`,
          {
            notificationConfiguration: {
              QueueConfigurations: [
                {
                  QueueArn: queue.queueArn,
                  Events: events,
                },
              ],
            },
          },
        );
      }

      yield* SQS.consumeQueueMessages(queue, (stream) =>
        stream.pipe(
          Stream.flatMap((record) =>
            Stream.fromArray((JSON.parse(record.body) as S3.S3Event).Records),
          ),
          Stream.map((event) => ({
            type: event.eventName as S3.S3EventType,
            bucket: event.s3.bucket.name,
            key: event.s3.object.key,
            size: event.s3.object.size,
            eTag: event.s3.object.eTag,
          })),
          process,
        ),
      );
    }) as S3.BucketEventSourceService;
  }),
).pipe(Layer.provideMerge(SQSQueueEventSource));
