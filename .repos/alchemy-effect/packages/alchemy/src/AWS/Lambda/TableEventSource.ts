import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import {
  TableEventSource as DynamoDBTableEventSource,
  type StreamRecord,
  type StreamsProps,
  type TableEventSourceService,
} from "../DynamoDB/Stream.ts";

import type { Table } from "../DynamoDB/Table.ts";
import { EventSourceMapping } from "./EventSourceMapping.ts";
import * as Lambda from "./Function.ts";

export const isDynamoDBStreamEvent = (
  event: any,
): event is lambda.DynamoDBStreamEvent =>
  Array.isArray(event?.Records) &&
  event.Records.length > 0 &&
  event.Records[0].eventSource === "aws:dynamodb";

export const TableEventSource = Layer.effect(
  DynamoDBTableEventSource,
  Effect.gen(function* () {
    const host = yield* Lambda.Function;
    const bind = yield* TableEventSourcePolicy;

    return Effect.fn(function* <Data = unknown, StreamReq = never, Req = never>(
      table: Table,
      props: StreamsProps,
      process: (
        stream: Stream.Stream<StreamRecord<Data>, never, StreamReq>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      const TableArn = yield* table.tableArn;

      yield* bind(table, props);

      yield* host.listen(
        Effect.gen(function* () {
          const tableArn = yield* TableArn;
          const streamArnPrefix = `${tableArn}/stream/`;

          return (event: any) => {
            if (isDynamoDBStreamEvent(event)) {
              const records = event.Records.filter(
                (record) =>
                  record.eventSourceARN?.startsWith(streamArnPrefix) === true,
              );
              if (records.length > 0) {
                return process(
                  Stream.fromArray(records as StreamRecord<Data>[]),
                ).pipe(Effect.orDie);
              }
            }
          };
        }),
      );
    }) as TableEventSourceService;
  }),
);

export class TableEventSourcePolicy extends Binding.Policy<
  TableEventSourcePolicy,
  (table: Table, props: StreamsProps) => Effect.Effect<void>
>()("AWS.DynamoDB.TableEventSource") {}

export const TableEventSourcePolicyLive = TableEventSourcePolicy.layer.effect(
  Effect.gen(function* () {
    const Mapping = yield* EventSourceMapping;

    return Effect.fn(function* (host, table, props) {
      if (Lambda.isFunction(host)) {
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
        yield* table.bind`AWS.DynamoDB.Stream(${host}, ${table}, ${streamViewType})`(
          {
            streamSpecification: {
              StreamEnabled: true,
              StreamViewType: streamViewType,
            },
          },
        );

        yield* Effect.logInfo(
          `Lambda TableEventSourcePolicy: creating mapping for ${host.LogicalId} <- ${table.LogicalId}`,
        );

        yield* host.bind`Allow(${host}, AWS.DynamoDB.Table.ReadStream(${table}))`(
          {
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
          },
        );

        yield* host.bind`Allow(${host}, AWS.DynamoDB.ListStreams(${table}))`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["dynamodb:ListStreams"],
              Resource: [table.tableArn],
            },
          ],
        });

        yield* Mapping(
          `AWS.Lambda.EventSourceMapping(${host.LogicalId}, ${table.LogicalId})`,
          {
            functionName: host.functionName,
            eventSourceArn: latestStreamArn,
            batchSize: props.batchSize,
            maximumBatchingWindowInSeconds:
              props.maximumBatchingWindowInSeconds,
            enabled: true,
            startingPosition: props.startingPosition ?? "LATEST",
            startingPositionTimestamp: props.startingPositionTimestamp,
            parallelizationFactor: props.parallelizationFactor,
            bisectBatchOnFunctionError: props.bisectBatchOnFunctionError,
            maximumRecordAgeInSeconds: props.maximumRecordAgeInSeconds,
            maximumRetryAttempts: props.maximumRetryAttempts,
            tumblingWindowInSeconds: props.tumblingWindowInSeconds,
          },
        );
      } else {
        return yield* Effect.die(
          new Error(
            `TableEventSourcePolicy does not support runtime '${host.Type}'`,
          ),
        );
      }
    });
  }),
);
