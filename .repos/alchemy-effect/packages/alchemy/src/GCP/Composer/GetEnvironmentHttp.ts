import * as composer from "@distilled.cloud/gcp/composer_v1";
import * as Layer from "effect/Layer";
import { makeEnvironmentHttpBinding } from "./BindingHttp.ts";
import { GetEnvironment } from "./GetEnvironment.ts";

/**
 * HTTP implementation of {@link GetEnvironment}.
 *
 * @layer
 * @provides GCP.Composer.GetEnvironment
 */
export const GetEnvironmentHttp = Layer.effect(
  GetEnvironment,
  makeEnvironmentHttpBinding({
    tag: "GCP.Composer.GetEnvironment",
    iam: { role: "roles/composer.viewer" },
    nameKey: "name",
    operation: composer.getProjectsLocationsEnvironments,
  }),
);
