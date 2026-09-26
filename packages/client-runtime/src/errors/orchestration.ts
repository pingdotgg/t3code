import {
  EnvironmentResourceNotFoundError,
  OrchestrationDispatchCommandError,
  OrchestrationThreadNotFoundError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

export type TerminalThreadNotFoundError =
  | EnvironmentResourceNotFoundError
  | OrchestrationThreadNotFoundError;

const isEnvironmentResourceNotFoundError = Schema.is(EnvironmentResourceNotFoundError);
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isOrchestrationThreadNotFoundError = Schema.is(OrchestrationThreadNotFoundError);

function isHttpThreadNotFoundError(error: unknown): error is EnvironmentResourceNotFoundError {
  return isEnvironmentResourceNotFoundError(error) && error.reason === "thread_not_found";
}

export function isTerminalThreadNotFoundError(
  error: unknown,
): error is TerminalThreadNotFoundError {
  return isHttpThreadNotFoundError(error) || isOrchestrationThreadNotFoundError(error);
}

export function findHttpThreadNotFoundError(
  cause: Cause.Cause<unknown>,
): EnvironmentResourceNotFoundError | undefined {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && isHttpThreadNotFoundError(reason.error)) {
      return reason.error;
    }
  }
  return undefined;
}

export function hasTerminalThreadNotFoundFailure(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some(
    (reason) => Cause.isFailReason(reason) && isTerminalThreadNotFoundError(reason.error),
  );
}

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

export function wasBootstrapThreadNotCreated(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "not-created"
  );
}
