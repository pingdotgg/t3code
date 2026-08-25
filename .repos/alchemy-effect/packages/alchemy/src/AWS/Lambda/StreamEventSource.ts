import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Namespace from "../../Namespace.ts";
import type { Stream as KinesisStream } from "../Kinesis/Stream.ts";
import {
  StreamEventSource as KinesisStreamEventSource,
  type KinesisEventRecord,
  type StreamEventSourceProps,
  type StreamEventSourceService,
} from "../Kinesis/StreamEventSource.ts";
import { EventSourceMapping } from "./EventSourceMapping.ts";
import * as Lambda from "./Function.ts";

export const isKinesisStreamEvent = (
  event: any,
): event is lambda.KinesisStreamEvent =>
  Array.isArray(event?.Records) &&
  event.Records.length > 0 &&
  event.Records[0].eventSource === "aws:kinesis";

/** @binding */
export const StreamEventSource = Layer.effect(
  KinesisStreamEventSource,
  Effect.gen(function* () {
    const host = yield* Lambda.Function;
    const Mapping = yield* EventSourceMapping;

    return Effect.fn(function* <StreamReq = never, Req = never>(
      stream: KinesisStream,
      props: StreamEventSourceProps,
      process: (
        stream: Stream.Stream<KinesisEventRecord, never, StreamReq>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      const StreamArn = yield* stream.streamArn;

      // Deploy-time: grant IAM and create the event-source mapping. Skipped once
      // running inside the deployed Function (the global guard), where the only
      // work is registering the runtime handler below. Namespaced under the host
      // so the mapping's logical identity matches the previous Binding.Policy.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* host.bind`Allow(${host}, AWS.Lambda.StreamEventSource(${stream}))`(
              {
                policyStatements: [
                  {
                    Effect: "Allow",
                    Action: [
                      "kinesis:DescribeStream",
                      "kinesis:GetRecords",
                      "kinesis:GetShardIterator",
                      "kinesis:ListShards",
                    ],
                    Resource: [stream.streamArn],
                  },
                ],
              },
            );

            yield* Mapping(
              `AWS.Lambda.EventSourceMapping(${host.LogicalId}, ${stream.LogicalId})`,
              {
                functionName: host.functionName,
                eventSourceArn: stream.streamArn,
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
                functionResponseTypes: props.functionResponseTypes,
                destinationConfig: props.destinationConfig,
                filterCriteria: props.filterCriteria,
                kmsKeyArn: props.kmsKeyArn,
                metricsConfig: props.metricsConfig,
              },
            );
          }),
        );
      }

      yield* host.listen(
        Effect.gen(function* () {
          const streamArn = yield* StreamArn;

          return (event: any) => {
            if (isKinesisStreamEvent(event)) {
              const records = event.Records.filter(
                (record) =>
                  record.eventSourceARN?.startsWith(streamArn) === true,
              );
              if (records.length > 0) {
                return process(
                  Stream.fromArray(records as KinesisEventRecord[]),
                ).pipe(Effect.orDie);
              }
            }
          };
        }),
      );
    }) as StreamEventSourceService;
  }),
);
