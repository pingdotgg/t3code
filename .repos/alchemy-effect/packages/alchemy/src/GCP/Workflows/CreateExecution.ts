import type * as workflowexecutions from "@distilled.cloud/gcp/workflowexecutions_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Workflow } from "./Workflow.ts";

export interface CreateExecutionRequest extends Omit<
  workflowexecutions.CreateProjectsLocationsWorkflowsExecutionsRequest,
  "parent"
> {}

/**
 * Runtime binding for Workflows `executions.create`.
 *
 * Starts a new execution of the latest revision of a {@link Workflow}.
 * Bind this operation in a Function/Action init phase. Provide
 * {@link CreateExecutionHttp}.
 *
 * ### Starting Executions
 * **Example:** Run the bound workflow
 * ```typescript
 * const createExecution = yield* GCP.Workflows.CreateExecution(greet);
 * const execution = yield* createExecution({
 *   body: { argument: JSON.stringify({ name: "world" }) },
 * });
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface CreateExecution extends Binding.Service<
  CreateExecution,
  "GCP.Workflows.CreateExecution",
  (
    workflow: Workflow,
  ) => Effect.Effect<
    (
      request?: CreateExecutionRequest,
    ) => Effect.Effect<
      workflowexecutions.Execution,
      workflowexecutions.CreateProjectsLocationsWorkflowsExecutionsError,
      RuntimeContext
    >
  >
> {}

export const CreateExecution = Binding.Service<CreateExecution>(
  "GCP.Workflows.CreateExecution",
);
