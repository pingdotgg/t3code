import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface CreateLogStreamRequest extends Omit<
  Logs.CreateLogStreamRequest,
  "logGroupName"
> {}

/**
 * Runtime binding for `logs:CreateLogStream`.
 *
 * Bind this operation to a `LogGroup` inside a function runtime to create
 * log streams dynamically (e.g. one stream per tenant or per day) before
 * writing to them with `PutLogEvents`, automatically injecting the log group
 * name. For a fixed stream known at deploy time, declare an
 * `AWS.Logs.LogStream` resource instead.
 * @binding
 * @section Writing Logs
 * @example Create a Per-Tenant Stream, Then Write
 * ```typescript
 * const createLogStream = yield* AWS.Logs.CreateLogStream(logGroup);
 * const putLogEvents = yield* AWS.Logs.PutLogEvents(logGroup);
 *
 * yield* createLogStream({ logStreamName: `tenant-${tenantId}` }).pipe(
 *   Effect.catchTag("ResourceAlreadyExistsException", () => Effect.void),
 * );
 * yield* putLogEvents({
 *   logStreamName: `tenant-${tenantId}`,
 *   logEvents: [{ timestamp, message }],
 * });
 * ```
 */
export interface CreateLogStream extends Binding.Service<
  CreateLogStream,
  "AWS.Logs.CreateLogStream",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request: CreateLogStreamRequest,
    ) => Effect.Effect<Logs.CreateLogStreamResponse, Logs.CreateLogStreamError>
  >
> {}
export const CreateLogStream = Binding.Service<CreateLogStream>(
  "AWS.Logs.CreateLogStream",
);
