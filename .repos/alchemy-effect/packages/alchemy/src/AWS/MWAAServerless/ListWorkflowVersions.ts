import type * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workflow } from "./Workflow.ts";

/**
 * Request accepted by the {@link ListWorkflowVersions} runtime callable.
 * The `WorkflowArn` is injected from the bound {@link Workflow}.
 */
export type ListWorkflowVersionsInput = Omit<
  mwaa.ListWorkflowVersionsRequest,
  "WorkflowArn"
>;

/**
 * Runtime binding for `airflow-serverless:ListWorkflowVersions`.
 *
 * Lists the versions of the bound {@link Workflow} (each update to the
 * workflow's definition or configuration publishes a new version). Useful
 * for pinning `StartWorkflowRun` to a specific version. Provide the
 * implementation with
 * `Effect.provide(AWS.MWAAServerless.ListWorkflowVersionsHttp)`.
 * @binding
 * @section Observing Workflows
 * @example List Workflow Versions
 * ```typescript
 * // init — bind the operation to the workflow
 * const listWorkflowVersions =
 *   yield* AWS.MWAAServerless.ListWorkflowVersions(workflow);
 *
 * // runtime
 * const { WorkflowVersions } = yield* listWorkflowVersions();
 * const latest = WorkflowVersions?.find((v) => v.IsLatestVersion);
 * ```
 */
export interface ListWorkflowVersions extends Binding.Service<
  ListWorkflowVersions,
  "AWS.MWAAServerless.ListWorkflowVersions",
  (
    workflow: Workflow,
  ) => Effect.Effect<
    (
      request?: ListWorkflowVersionsInput,
    ) => Effect.Effect<
      mwaa.ListWorkflowVersionsResponse,
      mwaa.ListWorkflowVersionsError
    >
  >
> {}
export const ListWorkflowVersions = Binding.Service<ListWorkflowVersions>(
  "AWS.MWAAServerless.ListWorkflowVersions",
);
