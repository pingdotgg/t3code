import * as composer from "@distilled.cloud/gcp/composer_v1";
import * as Layer from "effect/Layer";
import { makeUserWorkloadsSecretHttpBinding } from "./BindingHttp.ts";
import { GetUserWorkloadsSecret } from "./GetUserWorkloadsSecret.ts";

/**
 * HTTP implementation of {@link GetUserWorkloadsSecret}.
 *
 * @layer
 * @provides GCP.Composer.GetUserWorkloadsSecret
 */
export const GetUserWorkloadsSecretHttp = Layer.effect(
  GetUserWorkloadsSecret,
  makeUserWorkloadsSecretHttpBinding({
    tag: "GCP.Composer.GetUserWorkloadsSecret",
    iam: { role: "roles/composer.viewer" },
    operation: composer.getProjectsLocationsEnvironmentsUserWorkloadsSecrets,
  }),
);
