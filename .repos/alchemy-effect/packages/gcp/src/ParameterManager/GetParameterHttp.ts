import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import { GetParameter } from "./GetParameter.ts";
import type { Parameter } from "./Parameter.ts";

/**
 * HTTP implementation of {@link GetParameter}.
 *
 * @layer
 * @provides GCP.ParameterManager.GetParameter
 */
export const GetParameterHttp = Layer.effect(
  GetParameter,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getParameter = yield* GCPBindings.withCredentials(
      parametermanager.getProjectsLocationsParameters,
    );
    return Effect.fn(function* (parameter: Parameter) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.ParameterManager.GetParameter(${parameter})`({
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
      }
      const name = yield* parameter.name;
      return Effect.fn(`GCP.ParameterManager.GetParameter(${parameter.LogicalId})`)(function* () {
        return yield* getParameter({ name: yield* name });
      });
    });
  }),
);
