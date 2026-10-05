import type * as composer from "@distilled.cloud/gcp/composer_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Environment } from "./Environment.ts";

export interface ExecuteAirflowCommandRequest extends Omit<
  composer.ExecuteAirflowCommandProjectsLocationsEnvironmentsRequest,
  "environment"
> {}

/**
 * Runtime binding for Cloud Composer `environments.executeAirflowCommand`.
 *
 * Starts an Airflow CLI command in the environment. Bind this operation
 * to an {@link Environment} in a Function/Action init phase. Provide
 * {@link ExecuteAirflowCommandHttp}. Poll with
 * `environments.pollAirflowCommand` using the returned `executionId`.
 *
 * Grants `roles/composer.editor` on the project because it is the
 * narrowest predefined role with
 * `composer.environments.executeAirflowCommand`, and Composer
 * environments have no per-resource IAM policy.
 *
 * ### Running Airflow CLI
 * **Example:** List DAGs
 * ```typescript
 * const execute = yield* GCP.Composer.ExecuteAirflowCommand(airflow);
 * const started = yield* execute({
 *   body: { command: "dags", subcommand: "list" },
 * });
 * ```
 *
 * @binding
 * @category Composer
 */
export interface ExecuteAirflowCommand extends Binding.Service<
  ExecuteAirflowCommand,
  "GCP.Composer.ExecuteAirflowCommand",
  (
    environment: Environment,
  ) => Effect.Effect<
    (
      request?: ExecuteAirflowCommandRequest,
    ) => Effect.Effect<
      composer.ExecuteAirflowCommandResponse,
      composer.ExecuteAirflowCommandProjectsLocationsEnvironmentsError,
      RuntimeContext
    >
  >
> {}

export const ExecuteAirflowCommand = Binding.Service<ExecuteAirflowCommand>(
  "GCP.Composer.ExecuteAirflowCommand",
);
