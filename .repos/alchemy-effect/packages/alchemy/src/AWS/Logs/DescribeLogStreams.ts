import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface DescribeLogStreamsRequest extends Omit<
  Logs.DescribeLogStreamsRequest,
  "logGroupName" | "logGroupIdentifier"
> {}

/**
 * Runtime binding for `logs:DescribeLogStreams`.
 *
 * Bind this operation to a `LogGroup` inside a function runtime to list the
 * streams of the group (e.g. to discover the most recently written stream
 * before reading with `GetLogEvents`), automatically injecting the log group
 * name.
 * @binding
 * @section Reading Logs
 * @example Find the Most Recent Stream
 * ```typescript
 * const describeLogStreams = yield* AWS.Logs.DescribeLogStreams(logGroup);
 *
 * const { logStreams } = yield* describeLogStreams({
 *   orderBy: "LastEventTime",
 *   descending: true,
 *   limit: 1,
 * });
 * ```
 */
export interface DescribeLogStreams extends Binding.Service<
  DescribeLogStreams,
  "AWS.Logs.DescribeLogStreams",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request?: DescribeLogStreamsRequest,
    ) => Effect.Effect<
      Logs.DescribeLogStreamsResponse,
      Logs.DescribeLogStreamsError
    >
  >
> {}
export const DescribeLogStreams = Binding.Service<DescribeLogStreams>(
  "AWS.Logs.DescribeLogStreams",
);
