import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface DeleteLogStreamRequest extends Omit<
  Logs.DeleteLogStreamRequest,
  "logGroupName"
> {}

/**
 * Runtime binding for `logs:DeleteLogStream`.
 *
 * Bind this operation to a `LogGroup` inside a function runtime to delete
 * dynamically-created log streams (e.g. cleaning up per-tenant streams
 * created with `CreateLogStream`), automatically injecting the log group
 * name.
 * @binding
 * @section Writing Logs
 * @example Delete a Per-Tenant Stream
 * ```typescript
 * const deleteLogStream = yield* AWS.Logs.DeleteLogStream(logGroup);
 *
 * yield* deleteLogStream({ logStreamName: `tenant-${tenantId}` }).pipe(
 *   Effect.catchTag("ResourceNotFoundException", () => Effect.void),
 * );
 * ```
 */
export interface DeleteLogStream extends Binding.Service<
  DeleteLogStream,
  "AWS.Logs.DeleteLogStream",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request: DeleteLogStreamRequest,
    ) => Effect.Effect<Logs.DeleteLogStreamResponse, Logs.DeleteLogStreamError>
  >
> {}
export const DeleteLogStream = Binding.Service<DeleteLogStream>(
  "AWS.Logs.DeleteLogStream",
);
