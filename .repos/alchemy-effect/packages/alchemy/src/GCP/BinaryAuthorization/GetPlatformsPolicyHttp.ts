import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  GetPlatformsPolicy,
  type GetPlatformsPolicyRequest,
} from "./GetPlatformsPolicy.ts";
import type { PlatformsPolicy } from "./PlatformsPolicy.ts";
import { bindGcpHost } from "../Host.ts";

/**
 * HTTP implementation of {@link GetPlatformsPolicy}.
 *
 * @layer
 * @provides GCP.BinaryAuthorization.GetPlatformsPolicy
 */
export const GetPlatformsPolicyHttp = Layer.effect(
  GetPlatformsPolicy,
  Effect.gen(function* () {
    const getPolicy = yield* binaryauthorization.getProjectsPlatformsPolicies;
    return Effect.fn(function* (policy: PlatformsPolicy) {
      yield* bindGcpHost({
        tag: "GCP.BinaryAuthorization.GetPlatformsPolicy",
        resource: policy,
        // Platform policies have no resource-level IAM.
        iam: [{ role: "roles/binaryauthorization.policyViewer" }],
      });
      const name = yield* policy.name;
      return Effect.fn(
        `GCP.BinaryAuthorization.GetPlatformsPolicy(${policy.LogicalId})`,
      )(function* (request?: GetPlatformsPolicyRequest) {
        return yield* getPolicy({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
