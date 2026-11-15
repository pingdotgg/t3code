import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  TableEventSource as DynamoDBTableEventSource,
  type StreamRecord,
  type StreamsProps,
  type TableChangesHandler,
  type TableEventSourceService,
} from "../DynamoDB/Stream.ts";
import type { Table } from "../DynamoDB/Table.ts";
import { processBatch } from "../internal/EventSourceBatch.ts";
import { EventSourceMapping } from "./EventSourceMapping.ts";
import * as Lambda from "./Function.ts";

export const isDynamoDBStreamEvent = (event: any): event is lambda.DynamoDBStreamEvent =>
  Array.isArray(event?.Records) &&
  event.Records.length > 0 &&
  event.Records[0].eventSource === "aws:dynamodb";

/** @binding */
export const TableEventSource = Layer.effect(
  DynamoDBTableEventSource,
  Effect.gen(function* () {
    const host = yield* Lambda.eventSourceHost("AWS.Lambda.TableEventSource");
    const Mapping = yield* EventSourceMapping;

    return Effect.fn(function* <E = never, Req = never>(
      table: Table,
      props: StreamsProps,
      process: TableChangesHandler<E, Req>,
    ) {
      const TableArn = yield* table.tableArn;

      // Deploy-time: enable the table stream, grant IAM, and create the
      // event-source mapping. Skipped once running inside the deployed Function
      // (the global guard), where the only work is registering the runtime
      // handler below. Namespaced under the host so the mapping's logical
      // identity matches the previous Binding.Policy.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            const latestStreamArn = table.latestStreamArn.pipe(
              Output.mapEffect((arn) =>
                typeof arn === "string"
                  ? Effect.succeed(arn)
                  : Effect.die(`latestStreamArn is not a string: ${arn}`),
              ),
            );

            const streamViewType = props.streamViewType ?? "NEW_AND_OLD_IMAGES";

            yield* Effect.logInfo(
              `Lambda TableEventSource: binding stream ${streamViewType} for ${table.LogicalId}`,
            );
            yield* table.bind`AWS.DynamoDB.Stream(${host}, ${table}, ${streamViewType})`({
              streamSpecification: {
                StreamEnabled: true,
                StreamViewType: streamViewType,
              },
            });

            yield* Effect.logInfo(
              `Lambda TableEventSourcePolicy: creating mapping for ${host.LogicalId} <- ${table.LogicalId}`,
            );

            yield* host.bind`Allow(${host}, AWS.DynamoDB.Table.ReadStream(${table}))`({
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    "dynamodb:DescribeStream",
                    "dynamodb:GetRecords",
                    "dynamodb:GetShardIterator",
                  ],
                  Resource: [latestStreamArn],
                },
              ],
            });

            yield* host.bind`Allow(${host}, AWS.DynamoDB.ListStreams(${table}))`({
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["dynamodb:ListStreams"],
                  Resource: [table.tableArn],
                },
              ],
            });

            yield* Mapping(`AWS.Lambda.EventSourceMapping(${host.LogicalId}, ${table.LogicalId})`, {
              functionName: Lambda.qualifiedNameOf(host),
              eventSourceArn: latestStreamArn,
              batchSize: props.batchSize,
              maximumBatchingWindow: props.maximumBatchingWindow,
              enabled: true,
              startingPosition: props.startingPosition ?? "LATEST",
              startingPositionTimestamp: props.startingPositionTimestamp,
              parallelizationFactor: props.parallelizationFactor,
              bisectBatchOnFunctionError: props.bisectBatchOnFunctionError,
              maximumRecordAge: props.maximumRecordAge,
              maximumRetryAttempts: props.maximumRetryAttempts,
              tumblingWindow: props.tumblingWindow,
            });
          }),
        );
      }

      yield* host.listen(
        Effect.gen(function* () {
          const tableArn = yield* TableArn;
          const streamArnPrefix = `${tableArn}/stream/`;

          return (event: any) => {
            if (isDynamoDBStreamEvent(event)) {
              const records = event.Records.filter(
                (record) => record.eventSourceARN?.startsWith(streamArnPrefix) === true,
              );
              if (records.length > 0) {
                return process({
                  Records: records as StreamRecord<Record<string, lambda.AttributeValue>>[],
                }).pipe(
                  Effect.map((response) => response ?? { batchItemFailures: [] }),
                  processBatch({
                    system: "aws_dynamodb",
                    destination: tableArn.split("/")[1] ?? tableArn,
                    count: records.length,
                  }),
                  // A failure fails the invocation, so Lambda retries the whole batch.
                  Effect.orDie,
                );
              }
            }
          };
        }),
      );
    }) as TableEventSourceService;
  }),
);
