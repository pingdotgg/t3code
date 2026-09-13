import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

export function taskMembershipRejection(error: unknown) {
  return isOrchestrationDispatchCommandError(error) ? error.taskMembershipRejection : undefined;
}
