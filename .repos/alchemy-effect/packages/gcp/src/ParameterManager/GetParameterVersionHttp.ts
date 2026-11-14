import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import * as Layer from "effect/Layer";
import { makeParameterVersionHttpBinding } from "./BindingHttp.ts";
import { GetParameterVersion, type GetParameterVersionRequest } from "./GetParameterVersion.ts";

/**
 * HTTP implementation of {@link GetParameterVersion}.
 *
 * @layer
 * @provides GCP.ParameterManager.GetParameterVersion
 */
export const GetParameterVersionHttp = Layer.effect(
  GetParameterVersion,
  makeParameterVersionHttpBinding<
    parametermanager.GetProjectsLocationsParametersVersionsRequest,
    parametermanager.ParameterVersion,
    parametermanager.GetProjectsLocationsParametersVersionsError,
    GetParameterVersionRequest
  >({
    tag: "GCP.ParameterManager.GetParameterVersion",
    // Parameter Manager has no resource-level IAM; an IAM Condition on the
    // version name scopes the project grant to this version.
    iam: {
      role: "roles/parametermanager.parameterViewer",
      scopeByCondition: true,
    },
    operation: parametermanager.getProjectsLocationsParametersVersions,
    toInput: (name, request) => ({
      name,
      view: request?.view ?? "FULL",
    }),
  }),
);
