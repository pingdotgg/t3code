import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workflow } from "./Workflow.ts";

export interface StartRunRequest extends Omit<
  omics.StartRunRequest,
  "workflowId"
> {}

/**
 * Runtime binding for `omics:StartRun`.
 *
 * Bind this operation to a `Workflow` to get a callable that starts a run of the bound workflow — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.StartRunHttp)`.
 * @binding
 * @section Runs
 * @example Bind StartRun to a Workflow
 * ```typescript
 * // init
 * const startRun = yield* AWS.Omics.StartRun(workflow);
 * // runtime
 * const result = yield* startRun({});
 * ```
 */
export interface StartRun extends Binding.Service<
  StartRun,
  "AWS.Omics.StartRun",
  (
    workflow: Workflow,
  ) => Effect.Effect<
    (
      request?: StartRunRequest,
    ) => Effect.Effect<omics.StartRunResponse, omics.StartRunError>
  >
> {}

export const StartRun = Binding.Service<StartRun>("AWS.Omics.StartRun");
