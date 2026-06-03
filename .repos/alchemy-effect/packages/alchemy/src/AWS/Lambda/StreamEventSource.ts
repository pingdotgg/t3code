import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
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

export const StreamEventSource = Layer.effect(
  KinesisStreamEventSource,
  Effect.gen(function* () {
    const host = yield* Lambda.Function;
    const bind = yield* StreamEventSourcePolicy;

    return Effect.fn(function* <StreamReq = never, Req = never>(
      stream: KinesisStream,
      props: StreamEventSourceProps,
      process: (
        stream: Stream.Stream<KinesisEventRecord, never, StreamReq>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      const StreamArn = yield* stream.streamArn;

      yield* bind(stream, props);

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

export class StreamEventSourcePolicy extends Binding.Policy<
  StreamEventSourcePolicy,
  (stream: KinesisStream, props: StreamEventSourceProps) => Effect.Effect<void>
>()("AWS.Kinesis.StreamEventSource") {}

export const StreamEventSourcePolicyLive = StreamEventSourcePolicy.layer.effect(
  Effect.gen(function* () {
    const Mapping = yield* EventSourceMapping;

    return Effect.fn(function* (host, stream, props) {
      if (Lambda.isFunction(host)) {
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
            functionResponseTypes: props.functionResponseTypes,
            destinationConfig: props.destinationConfig,
            filterCriteria: props.filterCriteria,
            kmsKeyArn: props.kmsKeyArn,
            metricsConfig: props.metricsConfig,
          },
        );
      } else {
        return yield* Effect.die(
          new Error(
            `StreamEventSourcePolicy does not support runtime '${host.Type}'`,
          ),
        );
      }
    });
  }),
);
