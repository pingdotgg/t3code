import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Binding from "../../Binding.ts";
import type { Bucket } from "../S3/Bucket.ts";
import {
  BucketEventSource as S3BucketEventSource,
  type BucketEventSourceService,
} from "../S3/BucketEventSource.ts";
import type {
  BucketNotification,
  NotificationsProps,
} from "../S3/BucketNotifications.ts";
import type { S3EventType } from "../S3/S3Event.ts";
import * as Lambda from "./Function.ts";
import { Permission as LambdaPermission } from "./Permission.ts";

/**
 * Connects an S3 bucket notification stream to the current Lambda function.
 *
 * This layer listens for bucket notifications routed through the Lambda runtime
 * and exposes them as an `Effect.Stream`, while the companion policy configures
 * the invoke permission and bucket notification binding during deployment.
 *
 * @section Wiring Events
 * @example Listen for Object Created Events
 * ```typescript
 * yield* BucketEventSource.bind(
 *   bucket,
 *   { events: ["s3:ObjectCreated:*"] },
 *   (events) => Stream.runForEach(events, (event) => Effect.log(event.key)),
 * );
 * ```
 */
export const BucketEventSource = Layer.effect(
  S3BucketEventSource,
  Effect.gen(function* () {
    // this layer can only be used in a Lambda Function
    const func = yield* Lambda.Function;

    const bind = yield* BucketEventSourcePolicy;

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
      // this adds it to the Lambda Function's environment variables
      const BucketName = yield* bucket.bucketName;

      yield* bind(bucket, props);

      yield* func.listen(
        Effect.gen(function* () {
          // this accesses it
          const bucketName = yield* BucketName;
          return (event: any) => {
            if (isS3Event(event)) {
              const events = event.Records.filter(
                (record) => record.s3.bucket.name === bucketName,
              );
              if (events.length > 0) {
                return process(
                  Stream.fromArray(
                    events.map((record: lambda.S3EventRecord) => ({
                      type: record.eventName as S3EventType,
                      bucket: record.s3.bucket.name,
                      key: record.s3.object.key,
                      size: record.s3.object.size,
                      eTag: record.s3.object.eTag,
                    })),
                  ),
                  // TODO(sam): don't die?
                ).pipe(Effect.orDie);
              }
            }
          };
        }),
      );
    }) as BucketEventSourceService;
  }),
);

const isS3Event = (event: any): event is lambda.S3Event =>
  Array.isArray(event.Records) &&
  event.Records.some((record: any) => record.s3);

/**
 * Deploy-time policy for attaching an S3 bucket as a Lambda event source.
 */
export class BucketEventSourcePolicy extends Binding.Policy<
  BucketEventSourcePolicy,
  (
    bucket: Bucket,
    props?: NotificationsProps<S3EventType[]>,
  ) => Effect.Effect<void>
>()("AWS.S3.BucketEventSource") {}

export const BucketEventSourcePolicyLive = BucketEventSourcePolicy.layer.effect(
  Effect.gen(function* () {
    const Permission = yield* LambdaPermission;

    return Effect.fn(function* (
      host,
      bucket: Bucket,
      {
        events: Events = ["s3:ObjectCreated:*"],
      }: {
        events?: S3EventType[];
      } = {},
    ) {
      if (Lambda.isFunction(host)) {
        yield* Permission(`AWS.Lambda.InvokeFunction(${bucket.LogicalId})`, {
          action: "lambda.InvokeFunction",
          functionName: host.functionName,
          principal: "s3.amazonaws.com",
          sourceArn: bucket.bucketArn,
        });
        yield* bucket.bind(`AWS.S3.Notifications(${bucket.LogicalId})`, {
          notificationConfiguration: {
            LambdaFunctionConfigurations: [
              {
                LambdaFunctionArn: host.functionArn,
                Events,
              },
            ],
          },
        });
      } else {
        return yield* Effect.die(
          new Error(
            `BucketEventSourcePolicy does not support runtime '${host.Type}'`,
          ),
        );
      }
    });
  }),
);
