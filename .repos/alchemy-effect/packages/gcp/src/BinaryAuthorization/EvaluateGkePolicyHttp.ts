import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { EvaluateGkePolicy, type EvaluateGkePolicyRequest } from "./EvaluateGkePolicy.ts";
import type { PlatformsPolicy } from "./PlatformsPolicy.ts";

/**
 * HTTP implementation of {@link EvaluateGkePolicy}.
 *
 * @layer
 * @provides GCP.BinaryAuthorization.EvaluateGkePolicy
 */
export const EvaluateGkePolicyHttp = Layer.effect(
  EvaluateGkePolicy,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const evaluate = yield* GCPBindings.withCredentials(
      binaryauthorization.evaluateProjectsPlatformsGkePolicies,
    );
    return Effect.fn(function* (policy: PlatformsPolicy) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.BinaryAuthorization.EvaluateGkePolicy(${policy})`({
          // Platform policies have no resource-level IAM.
          iam: [{ role: "roles/binaryauthorization.policyEvaluator" }],
        });
      }
      const name = yield* policy.name;
      return Effect.fn(`GCP.BinaryAuthorization.EvaluateGkePolicy(${policy.LogicalId})`)(function* (
        request: EvaluateGkePolicyRequest,
      ) {
        return yield* evaluate({
          name: yield* name,
          body: request,
        });
      });
    });
  }),
);
