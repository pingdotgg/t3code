import * as DynamoDB from "alchemy/AWS/DynamoDB";
import * as Lambda from "alchemy/AWS/Lambda";
import * as S3 from "alchemy/AWS/S3";
import * as SQS from "alchemy/AWS/SQS";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stack } from "alchemy/Stack";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { Job } from "./Job.ts";

export class PutJobError extends Data.TaggedError("PutJobError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class GetJobError extends Data.TaggedError("GetJobError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class JobStorage extends Context.Service<
  JobStorage,
  {
    putJob(job: Job): Effect.Effect<Job, PutJobError>;
    getJob(jobId: string): Effect.Effect<Job | undefined, GetJobError>;
  }
>()("JobStorage") {}

export const JobStorageDynamoDB = Layer.provideMerge(
  Layer.effect(
    JobStorage,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const table = yield* DynamoDB.Table("JobsTable", {
        partitionKey: "id",
        attributes: {
          id: "S",
        },
      });
      const queue = yield* SQS.Queue("JobsQueue").pipe(
        RemovalPolicy.retain(stack.stage === "prod"),
      );

      const getItem = yield* DynamoDB.GetItem.bind(table);
      const putItem = yield* DynamoDB.PutItem.bind(table);
      const sink = yield* SQS.QueueSink.bind(queue);

      yield* DynamoDB.stream(table, {
        streamViewType: "NEW_AND_OLD_IMAGES",
        startingPosition: "LATEST",
        batchSize: 10,
      }).process((stream) =>
        stream.pipe(
          Stream.map((record) =>
            JSON.stringify({
              eventName: record.eventName,
              keys: record.dynamodb.Keys,
              newImage: record.dynamodb.NewImage,
              oldImage: record.dynamodb.OldImage,
            }),
          ),
          Stream.run(sink),
        ),
      );

      const putJob = (job: Job) =>
        putItem({
          Item: {
            id: { S: job.id },
            content: { S: job.content },
          },
        }).pipe(
          Effect.map(() => job),
          Effect.tapError(Console.log),
          Effect.catchCause((cause) =>
            Effect.fail(
              new PutJobError({
                message: `Failed to store job "${job.id}": ${cause}`,
                cause,
              }),
            ),
          ),
        );

      const getJob = (jobId: string) =>
        getItem({
          Key: {
            id: { S: jobId },
          },
        }).pipe(
          Effect.flatMap((item) =>
            item.Item
              ? Effect.try({
                  try: () =>
                    ({
                      id: item.Item?.id?.S ?? jobId,
                      content: item.Item?.content?.S ?? "",
                    }) as Job,
                  catch: (cause) =>
                    new GetJobError({
                      message: `Failed to parse job "${jobId}": ${cause}`,
                      cause,
                    }),
                })
              : Effect.succeed(undefined),
          ),
          Effect.tapError(Console.log),
          Effect.catchCause((cause) =>
            Effect.fail(
              new GetJobError({
                message: `Failed to load job "${jobId}": ${cause}`,
                cause,
              }),
            ),
          ),
        );

      return JobStorage.of({
        putJob,
        getJob,
      });
    }),
  ),
  Layer.mergeAll(Lambda.TableEventSource, SQS.QueueSinkLive).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DynamoDB.GetItemLive,
        DynamoDB.PutItemLive,
        SQS.SendMessageBatchLive,
      ),
    ),
  ),
);

export const JobStorageS3 = Layer.provideMerge(
  Layer.effect(
    JobStorage,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const bucket = yield* S3.Bucket("JobsBucket");
      const queue = yield* SQS.Queue("JobsQueue").pipe(
        RemovalPolicy.retain(stack.stage === "prod"),
      );

      const getObject = yield* S3.GetObject.bind(bucket);
      const putObject = yield* S3.PutObject.bind(bucket);
      const sink = yield* SQS.QueueSink.bind(queue);

      const putJob = (job: Job) =>
        putObject({
          Key: job.id,
          Body: JSON.stringify(job),
        }).pipe(
          Effect.map(() => job),
          Effect.tapError(Console.log),
          Effect.catchCause((cause) =>
            Effect.fail(
              new PutJobError({
                message: `Failed to store job "${job.id}": ${cause}`,
                cause,
              }),
            ),
          ),
        );

      const getJob = (jobId: string) =>
        getObject({
          Key: jobId,
        }).pipe(
          Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
          Effect.flatMap(
            (item) =>
              item?.Body?.pipe(
                Stream.decodeText,
                Stream.mkString,
                Effect.flatMap((body) =>
                  Effect.try({
                    try: () => JSON.parse(body) as Job,
                    catch: (cause) =>
                      new GetJobError({
                        message: `Failed to parse job "${jobId}": ${cause}`,
                        cause,
                      }),
                  }),
                ),
              ) ?? Effect.succeed(undefined),
          ),
          Effect.tapError(Console.log),
          Effect.catchCause((cause) =>
            Effect.fail(
              new GetJobError({
                message: `Failed to load job "${jobId}": ${cause}`,
                cause,
              }),
            ),
          ),
        );

      yield* S3.notifications(bucket).subscribe((stream) =>
        stream.pipe(
          Stream.flatMap((item) =>
            Stream.fromEffect(getJob(item.key).pipe(Effect.orDie)),
          ),
          Stream.filter((job): job is Job => job !== undefined),
          Stream.map((job) => JSON.stringify(job)),
          Stream.run(sink),
        ),
      );

      return JobStorage.of({
        putJob,
        getJob,
      });
    }),
  ),
  Layer.mergeAll(Lambda.BucketEventSource, SQS.QueueSinkLive).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        S3.GetObjectLive,
        S3.PutObjectLive,
        SQS.SendMessageBatchLive,
      ),
    ),
  ),
);
