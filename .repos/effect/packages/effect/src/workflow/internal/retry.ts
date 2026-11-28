import * as Context from "../../Context.ts"
import { constUndefined } from "../../Function.ts"

/**
 * The id of the execution whose `Activity.retry` the current fiber is inside.
 *
 * @internal
 */
export const RetryingExecution = Context.Reference<string | undefined>(
  "effect/workflow/Activity/RetryingExecution",
  { defaultValue: constUndefined }
)
