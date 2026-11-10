import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Shared waiter for Google long-running operations (`google.longrunning.Operation`
 * and the Compute `Operation` shape). Every provider waits through this one
 * helper so each service only states its time budget.
 *
 * NOT exported from `index.ts`.
 */

/** The subset of a long-running operation the waiter reads. */
export interface LongRunningOperation {
  name?: string;
  done?: boolean;
  /** Compute operations report `status: "DONE"` instead of `done`. */
  status?: string;
  error?: {
    code?: number;
    message?: string;
    /** Compute operations list their errors here. */
    errors?: ReadonlyArray<{ code?: string; message?: string }>;
  };
}

/** The operation finished with an error. */
export class OperationFailed extends Data.TaggedError("GCP.OperationFailed")<{
  operation: string;
  /** Numeric RPC code (google.rpc.Code), when reported. */
  code: number | undefined;
  /** Compute error code (e.g. `RESOURCE_NOT_FOUND`), when reported. */
  reason: string | undefined;
  message: string;
}> {}

/** The operation did not finish within the service's time budget. */
export class OperationTimedOut extends Data.TaggedError("GCP.OperationTimedOut")<{
  operation: string;
  budget: string;
}> {}

class OperationPending extends Data.TaggedError("GCP.OperationPending")<{
  operation: string;
}> {}

const isDone = (operation: LongRunningOperation) =>
  operation.done === true || operation.status === "DONE";

const failureOf = (operation: LongRunningOperation) => {
  const error = operation.error;
  if (error === undefined) return undefined;
  const first = error.errors?.[0];
  if (error.code === undefined && first === undefined && !error.message) {
    return undefined;
  }
  return new OperationFailed({
    operation: operation.name ?? "",
    code: error.code,
    reason: first?.code,
    message: first?.message ?? error.message ?? "operation failed",
  });
};

export interface WaitOptions {
  /**
   * How long the service may take. Use the real provisioning time for the
   * resource (Composer ~45m, AlloyDB/Cloud SQL ~20m, GKE ~20m), not a test
   * timeout.
   * @default "10 minutes"
   */
  budget?: Duration.Input;
  /** Poll interval. @default "5 seconds" */
  interval?: Duration.Input;
}

/**
 * Poll `get` until the operation is done, then fail with
 * {@link OperationFailed} if it reports an error. `get` re-reads the
 * operation by name with the service's own operations API.
 */
export const waitForOperation = <E extends { readonly _tag: string }, R>(
  operation: LongRunningOperation,
  get: (name: string) => Effect.Effect<LongRunningOperation, E, R>,
  options: WaitOptions = {},
): Effect.Effect<LongRunningOperation, E | OperationFailed | OperationTimedOut, R> => {
  const budget = Duration.fromInputUnsafe(options.budget ?? "10 minutes");
  const interval = Duration.fromInputUnsafe(options.interval ?? "5 seconds");
  const name = operation.name ?? "";
  const settle = (current: LongRunningOperation) => {
    const failed = failureOf(current);
    return failed ? Effect.fail(failed) : Effect.succeed(current);
  };
  if (isDone(operation) || name.length === 0) return settle(operation);
  const times = Math.max(1, Math.ceil(Duration.toMillis(budget) / Duration.toMillis(interval)));
  return get(name).pipe(
    Effect.flatMap((current) =>
      isDone(current)
        ? Effect.succeed(current)
        : Effect.fail(new OperationPending({ operation: name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.OperationPending",
      schedule: Schedule.spaced(interval),
      times,
    }),
    Effect.catchTag("GCP.OperationPending", () =>
      Effect.fail(
        new OperationTimedOut({
          operation: name,
          budget: Duration.format(budget),
        }),
      ),
    ),
    Effect.flatMap(settle),
  );
};
