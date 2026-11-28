import * as composer from "@distilled.cloud/gcp/composer_v1";
import * as Layer from "effect/Layer";
import { makeUserWorkloadsConfigMapHttpBinding } from "./BindingHttp.ts";
import { GetUserWorkloadsConfigMap } from "./GetUserWorkloadsConfigMap.ts";

/**
 * HTTP implementation of {@link GetUserWorkloadsConfigMap}.
 *
 * @layer
 * @provides GCP.Composer.GetUserWorkloadsConfigMap
 */
export const GetUserWorkloadsConfigMapHttp = Layer.effect(
  GetUserWorkloadsConfigMap,
  makeUserWorkloadsConfigMapHttpBinding({
    tag: "GCP.Composer.GetUserWorkloadsConfigMap",
    iam: { role: "roles/composer.viewer" },
    operation: composer.getProjectsLocationsEnvironmentsUserWorkloadsConfigMaps,
  }),
);
