import type * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workflow } from "./Workflow.ts";

/**
 * Request accepted by the {@link StartWorkflowRun} runtime callable. The
 * `WorkflowArn` is injected from the bound {@link Workflow}; the idempotency
 * `ClientToken` is auto-generated when omitted.
 */
export type StartWorkflowRunInput = Omit<
  mwaa.StartWorkflowRunRequest,
  "WorkflowArn"
>;

/**
 * Runtime binding for `airflow-serverless:StartWorkflowRun`.
 *
 * Starts an on-demand run of the bound {@link Workflow} — the serverless
 * equivalent of triggering a DAG. The workflow ARN is injected from the
 * binding; the caller can override workflow parameters or pin a specific
 * workflow version. Provide the implementation with
 * `Effect.provide(AWS.MWAAServerless.StartWorkflowRunHttp)`.
 * @binding
 * @section Running Workflows
 * @example Start An On-Demand Run
 * ```typescript
 * // init — bind the operation to the workflow
 * const startWorkflowRun = yield* AWS.MWAAServerless.StartWorkflowRun(workflow);
 *
 * // runtime
 * const run = yield* startWorkflowRun({
 *   OverrideParameters: { date: "2026-07-15" },
 * });
 * yield* Effect.log(`started run ${run.RunId} (${run.Status})`);
 * ```
 */
export interface StartWorkflowRun extends Binding.Service<
  StartWorkflowRun,
  "AWS.MWAAServerless.StartWorkflowRun",
  (
    workflow: Workflow,
  ) => Effect.Effect<
    (
      request?: StartWorkflowRunInput,
    ) => Effect.Effect<
      mwaa.StartWorkflowRunResponse,
      mwaa.StartWorkflowRunError
    >
  >
> {}
export const StartWorkflowRun = Binding.Service<StartWorkflowRun>(
  "AWS.MWAAServerless.StartWorkflowRun",
);
