/**
 * Per-task stop contract (fork f3).
 *
 * A "task" here is one subagent/workflow run inside a provider turn — the
 * thing `task.started` / `task.progress` / `task.completed` activities already
 * describe. Stopping one is a **plain unary RPC**, deliberately not an
 * orchestration command:
 *
 *   - Stopping records no durable state of its own. The provider guarantees a
 *     terminal task notification follows, which is already event-sourced as a
 *     `task.completed` activity with `status: "stopped"`.
 *   - `OrchestrationThreadStreamItem` carries `OrchestrationEvent` in a plain
 *     `Schema.Union` with no forward-compatible wrapper, so minting a new
 *     orchestration event type is a real decode hazard for older clients.
 *
 * Stops are **idempotent**: the server holds no in-flight guard, and a second
 * request for a task that has already settled succeeds and does nothing. That
 * is what makes the button safe to press during the race between "user clicks"
 * and "task finishes on its own".
 *
 * Every export is prefixed `Provider*` because `contracts/src/index.ts` is
 * `export *` over every module.
 *
 * @module contracts/providerTask
 */
import * as Schema from "effect/Schema";

import { RuntimeTaskId, ThreadId, TrimmedString } from "./baseSchemas.ts";

export const ProviderStopTaskInput = Schema.Struct({
  threadId: ThreadId,
  /** The `taskId` carried by the thread's `task.*` activities. */
  taskId: RuntimeTaskId,
});
export type ProviderStopTaskInput = typeof ProviderStopTaskInput.Type;

/**
 * The provider driving this thread cannot stop an individual task — its
 * adapter does not implement the operation. Distinct from a failure so the UI
 * can say "this provider can't stop tasks" instead of "stop failed".
 */
export class ProviderTaskStopUnsupportedError extends Schema.TaggedErrorClass<ProviderTaskStopUnsupportedError>()(
  "ProviderTaskStopUnsupportedError",
  {
    threadId: ThreadId,
    taskId: RuntimeTaskId,
  },
) {
  override get message(): string {
    return `This provider can't stop tasks.`;
  }
}

/**
 * The stop was attempted and the provider refused or the session is gone.
 * `detail` is safe to render.
 */
export class ProviderTaskStopFailedError extends Schema.TaggedErrorClass<ProviderTaskStopFailedError>()(
  "ProviderTaskStopFailedError",
  {
    threadId: ThreadId,
    taskId: RuntimeTaskId,
    detail: TrimmedString,
  },
) {
  override get message(): string {
    return `Could not stop task ${this.taskId}: ${this.detail}`;
  }
}

export const ProviderStopTaskError = Schema.Union([
  ProviderTaskStopUnsupportedError,
  ProviderTaskStopFailedError,
]);
export type ProviderStopTaskError = typeof ProviderStopTaskError.Type;
