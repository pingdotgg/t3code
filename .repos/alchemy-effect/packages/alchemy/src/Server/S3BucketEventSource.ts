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
import { normalizeBucketNotification } from "../AWS/S3/normalizeBucketNotification.ts";
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
        const filterRules = [
          ...(props.prefix !== undefined
            ? [{ Name: "prefix" as const, Value: props.prefix }]
            : []),
          ...(props.suffix !== undefined
            ? [{ Name: "suffix" as const, Value: props.suffix }]
            : []),
        ];
        yield* queue.bind(`AWS.SQS.SendMessage(${bucket.LogicalId})`, {
          policyStatements: [
            {
              Sid: `AllowS3EventsFrom${bucket.LogicalId}`,
              Effect: "Allow",
              Principal: { Service: "s3.amazonaws.com" },
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
                  ...(filterRules.length > 0
                    ? { Filter: { Key: { FilterRules: filterRules } } }
                    : {}),
                },
              ],
            },
          },
        );
      }

      yield* SQS.consumeQueueMessages(queue, (stream) =>
        stream.pipe(
          Stream.mapEffect((record) =>
            Effect.sync(
              () =>
                (JSON.parse(record.body) as { Records?: S3.S3Record[] })
                  .Records ?? [],
            ),
          ),
          Stream.flatMap((records) => Stream.fromArray(records)),
          Stream.mapEffect(normalizeBucketNotification),
          process,
        ),
      );
    }) as S3.BucketEventSourceService;
  }),
).pipe(Layer.provideMerge(SQSQueueEventSource));
