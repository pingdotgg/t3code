import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:ListWaitingWorkflowSteps`.
 *
 * Lists every workflow step in the account that is paused on
 * `WAIT_FOR_ACTION` — the work queue for an approval function, which then
 * resumes or stops each build with `SendWorkflowStepAction`. Provide the
 * implementation with
 * `Effect.provide(AWS.ImageBuilder.ListWaitingWorkflowStepsHttp)`.
 * @binding
 * @section Workflow Monitoring
 * @example List Steps Waiting for Action
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listWaitingWorkflowSteps =
 *   yield* AWS.ImageBuilder.ListWaitingWorkflowSteps();
 *
 * // runtime
 * const { steps } = yield* listWaitingWorkflowSteps();
 * ```
 */
export interface ListWaitingWorkflowSteps extends Binding.Service<
  ListWaitingWorkflowSteps,
  "AWS.ImageBuilder.ListWaitingWorkflowSteps",
  () => Effect.Effect<
    (
      request?: imagebuilder.ListWaitingWorkflowStepsRequest,
    ) => Effect.Effect<
      imagebuilder.ListWaitingWorkflowStepsResponse,
      imagebuilder.ListWaitingWorkflowStepsError
    >
  >
> {}
export const ListWaitingWorkflowSteps =
  Binding.Service<ListWaitingWorkflowSteps>(
    "AWS.ImageBuilder.ListWaitingWorkflowSteps",
  );
