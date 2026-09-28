import { ThreadUrl } from "@t3tools/contracts";
import { Cause, Effect, Exit, Schema } from "effect";

export const NestedThreadCreationErrorCode = Schema.Literals([
  "VALIDATION_FAILED",
  "WORKSPACE_PATH_OCCUPIED",
  "WORKSPACE_PATH_REGISTERED",
  "WORKSPACE_BRANCH_INVALID",
  "WORKSPACE_BRANCH_EXISTS",
  "WORKSPACE_BASE_REF_MISSING",
  "WORKSPACE_REPOSITORY_MISMATCH",
  "WORKSPACE_PREFLIGHT_FAILED",
  "WORKSPACE_CREATE_FAILED",
  "WORKSPACE_CLEANUP_FAILED",
  "AUDIT_PERSISTENCE_UNAVAILABLE",
  "THREAD_CREATE_REJECTED",
  "THREAD_CREATE_AMBIGUOUS",
  "TURN_START_REJECTED",
  "TURN_START_AMBIGUOUS",
  "THREAD_CLEANUP_REJECTED",
  "THREAD_CLEANUP_AMBIGUOUS",
  "CLI_EXECUTION_FAILED",
  "CLI_RESPONSE_INVALID",
]);
export type NestedThreadCreationErrorCode = typeof NestedThreadCreationErrorCode.Type;

const NestedThreadUrl = Schema.NullOr(ThreadUrl).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);

export const NestedThreadCreationOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("created"),
    assignmentId: Schema.optional(Schema.String),
    threadId: Schema.String,
    threadUrl: NestedThreadUrl,
    retryable: Schema.Literal(false),
    workspaceCreated: Schema.Boolean,
    cleanupPerformed: Schema.Literal(false),
    errorCode: Schema.Null,
    message: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("dry-run"),
    threadId: Schema.Null,
    threadUrl: NestedThreadUrl,
    retryable: Schema.Literal(false),
    workspaceCreated: Schema.Literal(false),
    cleanupPerformed: Schema.Literal(false),
    errorCode: Schema.Null,
    message: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    threadId: Schema.NullOr(Schema.String),
    threadUrl: NestedThreadUrl,
    retryable: Schema.Boolean,
    workspaceCreated: Schema.Boolean,
    cleanupPerformed: Schema.Boolean,
    errorCode: NestedThreadCreationErrorCode,
    message: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("ambiguous"),
    threadId: Schema.NullOr(Schema.String),
    threadUrl: NestedThreadUrl,
    retryable: Schema.Literal(false),
    workspaceCreated: Schema.Boolean,
    cleanupPerformed: Schema.Literal(false),
    errorCode: NestedThreadCreationErrorCode,
    message: Schema.String,
  }),
]);
export type NestedThreadCreationOutcome = typeof NestedThreadCreationOutcome.Type;

export const NestedThreadBatchCreationOutcome = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      index: Schema.Int,
      outcome: NestedThreadCreationOutcome,
    }),
  ),
});
export type NestedThreadBatchCreationOutcome = typeof NestedThreadBatchCreationOutcome.Type;

export interface NestedThreadPhaseFailure {
  readonly definitive: boolean;
  readonly message: string;
}

interface NestedThreadCreationPhases<R> {
  readonly createThread: Effect.Effect<ThreadUrl | null, unknown, R>;
  readonly startTurn: Effect.Effect<void, unknown, R>;
  readonly cleanupThread: Effect.Effect<void, unknown, R>;
  readonly classifyFailure: (error: unknown) => NestedThreadPhaseFailure;
}

const failureFromCause = (
  cause: Cause.Cause<unknown>,
  classifyFailure: (error: unknown) => NestedThreadPhaseFailure,
): NestedThreadPhaseFailure => {
  const error = Cause.findErrorOption(cause);
  return error._tag === "Some"
    ? classifyFailure(error.value)
    : { definitive: false, message: Cause.pretty(cause) };
};

export const runNestedThreadCreationPhases = <R>(
  threadId: string,
  workspaceCreated: boolean,
  phases: NestedThreadCreationPhases<R>,
): Effect.Effect<NestedThreadCreationOutcome, never, R> =>
  Effect.gen(function* () {
    const createExit = yield* Effect.exit(phases.createThread);
    if (Exit.isFailure(createExit)) {
      const failure = failureFromCause(createExit.cause, phases.classifyFailure);
      if (failure.definitive) {
        return {
          status: "failed",
          threadId: null,
          threadUrl: null,
          retryable: true,
          workspaceCreated,
          cleanupPerformed: false,
          errorCode: "THREAD_CREATE_REJECTED",
          message: `Thread creation was rejected before it committed: ${failure.message}`,
        };
      }
      return {
        status: "ambiguous",
        threadId,
        threadUrl: null,
        retryable: false,
        workspaceCreated,
        cleanupPerformed: false,
        errorCode: "THREAD_CREATE_AMBIGUOUS",
        message: `Thread creation may have committed, so retrying could create a duplicate. Inspect child thread '${threadId}' before retrying: ${failure.message}`,
      };
    }

    const turnExit = yield* Effect.exit(phases.startTurn);
    if (Exit.isSuccess(turnExit)) {
      return {
        status: "created",
        threadId,
        threadUrl: createExit.value,
        retryable: false,
        workspaceCreated,
        cleanupPerformed: false,
        errorCode: null,
        message: "Nested thread created and its first turn was accepted.",
      };
    }

    const turnFailure = failureFromCause(turnExit.cause, phases.classifyFailure);
    if (!turnFailure.definitive) {
      return {
        status: "ambiguous",
        threadId,
        threadUrl: null,
        retryable: false,
        workspaceCreated,
        cleanupPerformed: false,
        errorCode: "TURN_START_AMBIGUOUS",
        message: `The thread was created, but its first turn may have been accepted. The thread was preserved to avoid interrupting committed work: ${turnFailure.message}`,
      };
    }

    const cleanupExit = yield* Effect.exit(phases.cleanupThread);
    if (Exit.isSuccess(cleanupExit)) {
      return {
        status: "failed",
        threadId,
        threadUrl: null,
        retryable: true,
        workspaceCreated,
        cleanupPerformed: true,
        errorCode: "TURN_START_REJECTED",
        message: `The first turn was rejected and cleanup was accepted, so creation can be retried safely: ${turnFailure.message}`,
      };
    }

    const cleanupFailure = failureFromCause(cleanupExit.cause, phases.classifyFailure);
    if (cleanupFailure.definitive) {
      return {
        status: "failed",
        threadId,
        threadUrl: null,
        retryable: false,
        workspaceCreated,
        cleanupPerformed: false,
        errorCode: "THREAD_CLEANUP_REJECTED",
        message: `The first turn was rejected, but thread cleanup was also rejected. Delete child thread '${threadId}' before retrying: ${cleanupFailure.message}`,
      };
    }
    return {
      status: "ambiguous",
      threadId,
      threadUrl: null,
      retryable: false,
      workspaceCreated,
      cleanupPerformed: false,
      errorCode: "THREAD_CLEANUP_AMBIGUOUS",
      message: `The first turn was rejected, but cleanup may have committed. Inspect child thread '${threadId}' before retrying: ${cleanupFailure.message}`,
    };
  });

export const decodeNestedThreadCreationOutcome = Schema.decodeUnknownSync(
  NestedThreadCreationOutcome,
);

export const decodeNestedThreadBatchCreationOutcome = Schema.decodeUnknownSync(
  NestedThreadBatchCreationOutcome,
);
