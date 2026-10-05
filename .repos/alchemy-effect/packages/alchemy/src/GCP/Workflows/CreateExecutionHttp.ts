import * as workflowexecutions from "@distilled.cloud/gcp/workflowexecutions_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CreateExecution,
  type CreateExecutionRequest,
} from "./CreateExecution.ts";
import type { Workflow } from "./Workflow.ts";
import { bindGcpHost } from "../Host.ts";

/**
 * HTTP implementation of {@link CreateExecution}.
 *
 * @layer
 * @provides GCP.Workflows.CreateExecution
 */
export const CreateExecutionHttp = Layer.effect(
  CreateExecution,
  Effect.gen(function* () {
    const createExecution =
      yield* workflowexecutions.createProjectsLocationsWorkflowsExecutions;
    return Effect.fn(function* (workflow: Workflow) {
      yield* bindGcpHost({
        tag: "GCP.Workflows.CreateExecution",
        resource: workflow,
        // Workflows has no resource-level IAM; invoker is granted on the project.
        iam: [{ role: "roles/workflows.invoker" }],
      });
      const name = yield* workflow.name;
      return Effect.fn(`GCP.Workflows.CreateExecution(${workflow.LogicalId})`)(
        function* (request?: CreateExecutionRequest) {
          const parent = yield* name;
          return yield* createExecution({ ...request, parent });
        },
      );
    });
  }),
);
