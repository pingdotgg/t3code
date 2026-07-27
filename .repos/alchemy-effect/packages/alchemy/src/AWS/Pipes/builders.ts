import type * as pipes from "@distilled.cloud/aws/pipes";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Table } from "../DynamoDB/Table.ts";
import * as IAM from "../IAM/index.ts";
import type { Stream } from "../Kinesis/Stream.ts";
import type { Function } from "../Lambda/Function.ts";
import type { Queue } from "../SQS/Queue.ts";
import { Pipe, type PipeDesiredState } from "./Pipe.ts";

/**
 * Resources the {@link from} builder accepts as a pipe source. DynamoDB
 * tables must have streams enabled (`latestStreamArn` defined).
 */
export type PipeSource = Queue | Stream | Table;

export interface PipeSourceOptions {
  /**
   * Maximum number of source records per delivered batch.
   */
  batchSize?: number;
  /**
   * Maximum time to gather records before delivering a batch (e.g.
   * `"30 seconds"` or `Duration.seconds(30)`). Sent to the API in whole
   * seconds.
   */
  maximumBatchingWindow?: Duration.Input;
  /**
   * Where to start reading a Kinesis or DynamoDB stream source. Ignored
   * for SQS sources. Changing it triggers a replacement.
   * @default "LATEST"
   */
  startingPosition?: "TRIM_HORIZON" | "LATEST";
}

export interface PipeTargetOptions {
  /**
   * Explicit physical pipe name. Also used as the logical ID, so it must
   * be deterministic. If omitted, a logical ID is derived from the source
   * and target logical IDs and the physical name is auto-generated.
   */
  name?: string;
  /**
   * A description of the pipe.
   */
  description?: string;
  /**
   * The state the pipe should be in.
   * @default "RUNNING"
   */
  desiredState?: PipeDesiredState;
  /**
   * Input template applied to each record before delivery to the target.
   */
  inputTemplate?: string;
}

export interface LambdaTargetOptions extends PipeTargetOptions {
  /**
   * How the target Lambda function is invoked.
   * @default "REQUEST_RESPONSE"
   */
  invocationType?: "REQUEST_RESPONSE" | "FIRE_AND_FORGET";
}

export interface QueueTargetOptions extends PipeTargetOptions {
  /**
   * Message group ID for FIFO target queues.
   */
  messageGroupId?: string;
  /**
   * Message deduplication ID for FIFO target queues.
   */
  messageDeduplicationId?: string;
}

interface PipeBuilderState {
  source: PipeSource;
  options: PipeSourceOptions;
  filters: string[];
  enrichment?: {
    fn: Function;
    parameters?: pipes.PipeEnrichmentParameters;
  };
}

/**
 * Start building an EventBridge Pipe from a source resource. The terminal
 * `.toLambda(...)` / `.toQueue(...)` call synthesizes the
 * `pipes.amazonaws.com` execution role — source-read plus target-invoke
 * (plus enrichment-invoke) policies scoped to the exact resource ARNs —
 * and yields the {@link Pipe}.
 *
 * ```typescript
 * const pipe = yield* AWS.Pipes.from(queue, { batchSize: 1 })
 *   .filter(JSON.stringify({ body: { type: ["order.created"] } }))
 *   .toLambda(fn);
 * ```
 */
export const from = (source: PipeSource, options: PipeSourceOptions = {}) =>
  makePipeBuilder({ source, options, filters: [] });

const makePipeBuilder = (state: PipeBuilderState) => ({
  /**
   * Add EventBridge event-pattern filters. Only source events matching at
   * least one pattern reach the enrichment/target. Accepts pattern strings
   * or plain objects (JSON-stringified).
   */
  filter: (...patterns: (string | Record<string, unknown>)[]) =>
    makePipeBuilder({
      ...state,
      filters: [
        ...state.filters,
        ...patterns.map((pattern) =>
          typeof pattern === "string" ? pattern : JSON.stringify(pattern),
        ),
      ],
    }),

  /**
   * Enrich each batch with a Lambda function before delivery to the
   * target. The synthesized role is granted `lambda:InvokeFunction` on the
   * enrichment function.
   */
  enrich: (fn: Function, parameters?: pipes.PipeEnrichmentParameters) =>
    makePipeBuilder({ ...state, enrichment: { fn, parameters } }),

  /**
   * Deliver batches to a Lambda function target.
   */
  toLambda: (fn: Function, options: LambdaTargetOptions = {}) =>
    materializePipe(
      state,
      fn.LogicalId,
      [
        {
          Effect: "Allow",
          Action: ["lambda:InvokeFunction"],
          Resource: [fn.functionArn],
        },
      ],
      fn.functionArn,
      {
        InputTemplate: options.inputTemplate,
        LambdaFunctionParameters: options.invocationType
          ? { InvocationType: options.invocationType }
          : undefined,
      },
      options,
    ),

  /**
   * Deliver batches to an SQS queue target.
   */
  toQueue: (queue: Queue, options: QueueTargetOptions = {}) =>
    materializePipe(
      state,
      queue.LogicalId,
      [
        {
          Effect: "Allow",
          Action: ["sqs:SendMessage"],
          Resource: [queue.queueArn],
        },
      ],
      queue.queueArn,
      {
        InputTemplate: options.inputTemplate,
        SqsQueueParameters:
          options.messageGroupId !== undefined ||
          options.messageDeduplicationId !== undefined
            ? {
                MessageGroupId: options.messageGroupId,
                MessageDeduplicationId: options.messageDeduplicationId,
              }
            : undefined,
      },
      options,
    ),
});

interface SourceSpec {
  arn: unknown;
  statements: unknown[];
  parameters: pipes.PipeSourceParameters;
}

const sourceSpec = (state: PipeBuilderState): SourceSpec => {
  const { source, options, filters } = state;
  // The wire field is whole seconds.
  const maximumBatchingWindowInSeconds = toWireSeconds(
    options.maximumBatchingWindow,
  );
  const filterCriteria: Pick<pipes.PipeSourceParameters, "FilterCriteria"> =
    filters.length > 0
      ? { FilterCriteria: { Filters: filters.map((Pattern) => ({ Pattern })) } }
      : {};
  switch (source.Type) {
    case "AWS.SQS.Queue":
      return {
        arn: source.queueArn,
        statements: [
          {
            Effect: "Allow",
            Action: [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes",
            ],
            Resource: [source.queueArn],
          },
        ],
        parameters: {
          ...filterCriteria,
          SqsQueueParameters: {
            BatchSize: options.batchSize,
            MaximumBatchingWindowInSeconds: maximumBatchingWindowInSeconds,
          },
        },
      };
    case "AWS.Kinesis.Stream":
      return {
        arn: source.streamArn,
        statements: [
          {
            Effect: "Allow",
            Action: [
              "kinesis:DescribeStream",
              "kinesis:DescribeStreamSummary",
              "kinesis:GetRecords",
              "kinesis:GetShardIterator",
              "kinesis:ListShards",
              "kinesis:ListStreams",
            ],
            Resource: [source.streamArn],
          },
        ],
        parameters: {
          ...filterCriteria,
          KinesisStreamParameters: {
            StartingPosition: options.startingPosition ?? "LATEST",
            BatchSize: options.batchSize,
            MaximumBatchingWindowInSeconds: maximumBatchingWindowInSeconds,
          },
        },
      };
    case "AWS.DynamoDB.Table":
      return {
        arn: source.latestStreamArn,
        statements: [
          {
            Effect: "Allow",
            Action: [
              "dynamodb:DescribeStream",
              "dynamodb:GetRecords",
              "dynamodb:GetShardIterator",
              "dynamodb:ListStreams",
            ],
            Resource: [source.latestStreamArn],
          },
        ],
        parameters: {
          ...filterCriteria,
          DynamoDBStreamParameters: {
            StartingPosition: options.startingPosition ?? "LATEST",
            BatchSize: options.batchSize,
            MaximumBatchingWindowInSeconds: maximumBatchingWindowInSeconds,
          },
        },
      };
  }
};

const materializePipe = (
  state: PipeBuilderState,
  targetId: string,
  targetStatements: unknown[],
  targetArn: unknown,
  targetParameters: pipes.PipeTargetParameters,
  options: PipeTargetOptions,
) =>
  Effect.gen(function* () {
    const src = sourceSpec(state);
    const pipeId = options.name ?? `${state.source.LogicalId}To${targetId}Pipe`;

    const enrichmentStatements = state.enrichment
      ? [
          {
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: [state.enrichment.fn.functionArn],
          },
        ]
      : [];

    const role = yield* IAM.Role(`${pipeId}Role`, {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "pipes.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        PipeSource: {
          Version: "2012-10-17",
          Statement: src.statements as any,
        },
        PipeTarget: {
          Version: "2012-10-17",
          Statement: [...targetStatements, ...enrichmentStatements] as any,
        },
      },
    });

    return yield* Pipe(pipeId, {
      pipeName: options.name,
      description: options.description,
      desiredState: options.desiredState,
      source: src.arn as any,
      sourceParameters: src.parameters,
      enrichment: state.enrichment
        ? (state.enrichment.fn.functionArn as any)
        : undefined,
      enrichmentParameters: state.enrichment?.parameters,
      target: targetArn as any,
      targetParameters,
      roleArn: role.roleArn,
    });
  });
