import * as composer from "@distilled.cloud/gcp/composer_v1";
import * as Layer from "effect/Layer";
import { makeEnvironmentHttpBinding } from "./BindingHttp.ts";
import { ExecuteAirflowCommand } from "./ExecuteAirflowCommand.ts";

/**
 * HTTP implementation of {@link ExecuteAirflowCommand}.
 *
 * Grants `roles/composer.editor` on the project because
 * `composer.environments.executeAirflowCommand` is in no narrower
 * predefined role and Composer environments have no resource-level IAM.
 *
 * @layer
 * @provides GCP.Composer.ExecuteAirflowCommand
 */
export const ExecuteAirflowCommandHttp = Layer.effect(
  ExecuteAirflowCommand,
  makeEnvironmentHttpBinding({
    tag: "GCP.Composer.ExecuteAirflowCommand",
    iam: { role: "roles/composer.editor" },
    nameKey: "environment",
    operation: composer.executeAirflowCommandProjectsLocationsEnvironments,
  }),
);
