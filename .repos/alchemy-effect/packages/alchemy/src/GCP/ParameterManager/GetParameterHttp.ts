import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GetParameter } from "./GetParameter.ts";
import type { Parameter } from "./Parameter.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor } from "../HttpBinding.ts";

/**
 * HTTP implementation of {@link GetParameter}.
 *
 * @layer
 * @provides GCP.ParameterManager.GetParameter
 */
export const GetParameterHttp = Layer.effect(
  GetParameter,
  Effect.gen(function* () {
    const getParameter = yield* parametermanager.getProjectsLocationsParameters;
    return Effect.fn(function* (parameter: Parameter) {
      yield* bindGcpHost({
        tag: "GCP.ParameterManager.GetParameter",
        resource: parameter,
        // Parameter Manager has no resource-level IAM; an IAM Condition on
        // the parameter name scopes the project grant to this parameter.
        iam: [
          grantFor(
            {
              role: "roles/parametermanager.parameterViewer",
              scopeByCondition: true,
            },
            parameter.name,
          ),
        ],
      });
      const name = yield* parameter.name;
      return Effect.fn(
        `GCP.ParameterManager.GetParameter(${parameter.LogicalId})`,
      )(function* () {
        return yield* getParameter({ name: yield* name });
      });
    });
  }),
);
