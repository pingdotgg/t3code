import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ConfigRule } from "./ConfigRule.ts";

/** Request for {@link PutExternalEvaluation} — the rule name is injected from the bound rule. */
export interface PutExternalEvaluationRequest extends Omit<
  config.PutExternalEvaluationRequest,
  "ConfigRuleName"
> {}

/**
 * Runtime binding for `config:PutExternalEvaluation` — push an externally
 * computed compliance verdict for one resource into the bound
 * {@link ConfigRule} (the rule must use the external evaluation mode); the
 * rule name is injected automatically.
 *
 * Provide `Config.PutExternalEvaluationHttp` on the hosting Lambda Function
 * to satisfy the requirement.
 * @binding
 * @section Reporting Evaluations (Custom Rules)
 * @example Push an External Evaluation
 * ```typescript
 * // init — grants config:PutExternalEvaluation
 * const putExternalEvaluation = yield* AWS.Config.PutExternalEvaluation(rule);
 *
 * // runtime
 * yield* putExternalEvaluation({
 *   ExternalEvaluation: {
 *     ComplianceResourceType: "AWS::S3::Bucket",
 *     ComplianceResourceId: "my-bucket",
 *     ComplianceType: "COMPLIANT",
 *     OrderingTimestamp: new Date(),
 *   },
 * });
 * ```
 */
export interface PutExternalEvaluation extends Binding.Service<
  PutExternalEvaluation,
  "AWS.Config.PutExternalEvaluation",
  (
    rule: ConfigRule,
  ) => Effect.Effect<
    (
      request: PutExternalEvaluationRequest,
    ) => Effect.Effect<
      config.PutExternalEvaluationResponse,
      config.PutExternalEvaluationError
    >
  >
> {}

export const PutExternalEvaluation = Binding.Service<PutExternalEvaluation>(
  "AWS.Config.PutExternalEvaluation",
);
