import type * as sfn from "@distilled.cloud/aws/sfn";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Activity } from "./Activity.ts";

export interface SendTaskHeartbeatRequest extends sfn.SendTaskHeartbeatInput {}

/**
 * Runtime binding for `states:SendTaskHeartbeat`.
 *
 * Reports liveness for a long-running callback-pattern task
 * (`.waitForTaskToken`) or {@link Activity} task so its
 * `HeartbeatSeconds` timeout does not fire. Bind without arguments for
 * task tokens issued by service-integration Task states, or pass an
 * `Activity` to scope access.
 * @binding
 * @section Callback Pattern
 * @example Keep a waiting task alive
 * ```typescript
 * const sendTaskHeartbeat = yield* StepFunctions.SendTaskHeartbeat();
 *
 * yield* sendTaskHeartbeat({ taskToken: token });
 * ```
 */
export interface SendTaskHeartbeat extends Binding.Service<
  SendTaskHeartbeat,
  "AWS.StepFunctions.SendTaskHeartbeat",
  (
    activity?: Activity,
  ) => Effect.Effect<
    (
      request: SendTaskHeartbeatRequest,
    ) => Effect.Effect<sfn.SendTaskHeartbeatOutput, sfn.SendTaskHeartbeatError>
  >
> {}
export const SendTaskHeartbeat = Binding.Service<SendTaskHeartbeat>(
  "AWS.StepFunctions.SendTaskHeartbeat",
);
