import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export class DynamoDBStreamFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "DynamoDBStreamFunction",
) {}

export class TableAndQueue extends Context.Service<
  TableAndQueue,
  {
    table: AWS.DynamoDB.Table;
    queue: AWS.SQS.Queue;
  }
>()("TableAndQueue") {}

export const TableAndQueueLive = Layer.effect(
  TableAndQueue,
  Effect.gen(function* () {
    const table = yield* AWS.DynamoDB.Table("StreamSourceTable", {
      partitionKey: "pk",
      sortKey: "sk",
      attributes: {
        pk: "S",
        sk: "S",
      },
    });
    const queue = yield* AWS.SQS.Queue("StreamSinkQueue");
    return {
      table,
      queue,
    };
  }),
);

export default DynamoDBStreamFunction.make(
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const { table, queue } = yield* TableAndQueue;
    const sink = yield* AWS.SQS.QueueSink(queue);

    yield* AWS.DynamoDB.consumeTableChanges(
      table,
      {
        streamViewType: "NEW_AND_OLD_IMAGES",
        startingPosition: "TRIM_HORIZON",
        batchSize: 10,
      },
      (stream) =>
        stream.pipe(
          Stream.map((record) => ({
            MessageBody: JSON.stringify({
              eventName: record.eventName,
              keys: record.dynamodb.Keys,
              newImage: record.dynamodb.NewImage,
              oldImage: record.dynamodb.OldImage,
            }),
          })),
          Stream.run(sink),
          Effect.orDie,
        ),
    );
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(
          AWS.Lambda.TableEventSource,
          AWS.SQS.QueueSinkHttp,
          TableAndQueueLive,
        ),
        Layer.mergeAll(AWS.SQS.SendMessageBatchHttp),
      ),
    ),
  ),
);
