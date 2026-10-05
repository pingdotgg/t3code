import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  EvaluateGkePolicy,
  type EvaluateGkePolicyRequest,
} from "./EvaluateGkePolicy.ts";
import type { PlatformsPolicy } from "./PlatformsPolicy.ts";
import { bindGcpHost } from "../Host.ts";

/**
 * HTTP implementation of {@link EvaluateGkePolicy}.
 *
 * @layer
 * @provides GCP.BinaryAuthorization.EvaluateGkePolicy
 */
export const EvaluateGkePolicyHttp = Layer.effect(
  EvaluateGkePolicy,
  Effect.gen(function* () {
    const evaluate =
      yield* binaryauthorization.evaluateProjectsPlatformsGkePolicies;
    return Effect.fn(function* (policy: PlatformsPolicy) {
      yield* bindGcpHost({
        tag: "GCP.BinaryAuthorization.EvaluateGkePolicy",
        resource: policy,
        // Platform policies have no resource-level IAM.
        iam: [{ role: "roles/binaryauthorization.policyEvaluator" }],
      });
      const name = yield* policy.name;
      return Effect.fn(
        `GCP.BinaryAuthorization.EvaluateGkePolicy(${policy.LogicalId})`,
      )(function* (request: EvaluateGkePolicyRequest) {
        return yield* evaluate({
          name: yield* name,
          body: request,
        });
      });
    });
  }),
);
