import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { ParametersVersion } from "./ParametersVersion.ts";
import { RenderParameterVersion } from "./RenderParameterVersion.ts";

/**
 * HTTP implementation of {@link RenderParameterVersion}.
 *
 * @layer
 * @provides GCP.ParameterManager.RenderParameterVersion
 */
export const RenderParameterVersionHttp = Layer.effect(
  RenderParameterVersion,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const render = yield* GCPBindings.withCredentials(
      parametermanager.renderProjectsLocationsParametersVersions,
    );
    return Effect.fn(function* (version: ParametersVersion) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.ParameterManager.RenderParameterVersion(${version})`({
          // Parameter Manager has no resource-level IAM; an IAM Condition on
          // the version name scopes the project grant to this version.
          iam: [
            grantFor(
              {
                role: "roles/parametermanager.parameterAccessor",
                scopeByCondition: true,
              },
              version.name,
            ),
          ],
        });
      }
      const name = yield* version.name;
      return Effect.fn(`GCP.ParameterManager.RenderParameterVersion(${version.LogicalId})`)(
        function* () {
          return yield* render({ name: yield* name });
        },
      );
    });
  }),
);
