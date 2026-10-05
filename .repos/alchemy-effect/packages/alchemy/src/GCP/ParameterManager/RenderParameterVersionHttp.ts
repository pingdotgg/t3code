import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ParametersVersion } from "./ParametersVersion.ts";
import { RenderParameterVersion } from "./RenderParameterVersion.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor } from "../HttpBinding.ts";

/**
 * HTTP implementation of {@link RenderParameterVersion}.
 *
 * @layer
 * @provides GCP.ParameterManager.RenderParameterVersion
 */
export const RenderParameterVersionHttp = Layer.effect(
  RenderParameterVersion,
  Effect.gen(function* () {
    const render =
      yield* parametermanager.renderProjectsLocationsParametersVersions;
    return Effect.fn(function* (version: ParametersVersion) {
      yield* bindGcpHost({
        tag: "GCP.ParameterManager.RenderParameterVersion",
        resource: version,
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
      const name = yield* version.name;
      return Effect.fn(
        `GCP.ParameterManager.RenderParameterVersion(${version.LogicalId})`,
      )(function* () {
        return yield* render({ name: yield* name });
      });
    });
  }),
);
