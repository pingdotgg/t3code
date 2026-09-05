import {
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

const isOrchestrationGetSnapshotError = Schema.is(OrchestrationGetSnapshotError);

/** Set by the server when a subscribeThread miss has no snapshot (`apps/server/src/ws.ts`). */
export function wasSubscribeThreadNotFound(error: unknown): boolean {
  return isOrchestrationGetSnapshotError(error) && error.threadDisposition === "not-found";
}
