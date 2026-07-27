import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:ListWorkflowExecutions`.
 *
 * Enumerates the build/test/distribution workflow runs of an image build
 * version — the drill-down view of what a build is currently doing (each
 * entry reports the workflow's status and step counts). Account-level
 * binding: pass the `imageBuildVersionArn`. Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.ListWorkflowExecutionsHttp)`.
 * @binding
 * @section Observing Builds
 * @example Inspect a Build's Workflow Progress
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listWorkflowExecutions =
 *   yield* AWS.ImageBuilder.ListWorkflowExecutions();
 *
 * // runtime
 * const { workflowExecutions } = yield* listWorkflowExecutions({
 *   imageBuildVersionArn,
 * });
 * for (const execution of workflowExecutions ?? []) {
 *   yield* Effect.log(`${execution.type}: ${execution.status}`);
 * }
 * ```
 */
export interface ListWorkflowExecutions extends Binding.Service<
  ListWorkflowExecutions,
  "AWS.ImageBuilder.ListWorkflowExecutions",
  () => Effect.Effect<
    (
      request: imagebuilder.ListWorkflowExecutionsRequest,
    ) => Effect.Effect<
      imagebuilder.ListWorkflowExecutionsResponse,
      imagebuilder.ListWorkflowExecutionsError
    >
  >
> {}
export const ListWorkflowExecutions = Binding.Service<ListWorkflowExecutions>(
  "AWS.ImageBuilder.ListWorkflowExecutions",
);
