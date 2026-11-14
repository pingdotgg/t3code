import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { GetPlatformsPolicy, type GetPlatformsPolicyRequest } from "./GetPlatformsPolicy.ts";
import type { PlatformsPolicy } from "./PlatformsPolicy.ts";

/**
 * HTTP implementation of {@link GetPlatformsPolicy}.
 *
 * @layer
 * @provides GCP.BinaryAuthorization.GetPlatformsPolicy
 */
export const GetPlatformsPolicyHttp = Layer.effect(
  GetPlatformsPolicy,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getPolicy = yield* GCPBindings.withCredentials(
      binaryauthorization.getProjectsPlatformsPolicies,
    );
    return Effect.fn(function* (policy: PlatformsPolicy) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.BinaryAuthorization.GetPlatformsPolicy(${policy})`({
          // Platform policies have no resource-level IAM.
          iam: [{ role: "roles/binaryauthorization.policyViewer" }],
        });
      }
      const name = yield* policy.name;
      return Effect.fn(`GCP.BinaryAuthorization.GetPlatformsPolicy(${policy.LogicalId})`)(
        function* (request?: GetPlatformsPolicyRequest) {
          return yield* getPolicy({
            ...request,
            name: yield* name,
          });
        },
      );
    });
  }),
);
