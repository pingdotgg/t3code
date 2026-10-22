import {
  OrchestrationDispatchCommandError,
  OrchestrationV2DispatchCommandError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isOrchestrationV2DispatchCommandError = Schema.is(OrchestrationV2DispatchCommandError);

/**
 * A conditional discard kept the thread: a message landed first, or it was
 * promoted out of being a side chat. Expected, not a failure.
 */
export function wasDiscardRefused(error: unknown): boolean {
  return (
    isOrchestrationV2DispatchCommandError(error) &&
    (error.reason === "thread_not_empty" || error.reason === "thread_not_side_chat")
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
