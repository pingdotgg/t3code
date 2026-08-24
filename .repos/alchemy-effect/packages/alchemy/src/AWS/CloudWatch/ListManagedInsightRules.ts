import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListManagedInsightRulesRequest
  extends cloudwatch.ListManagedInsightRulesInput {}

/**
 * Runtime binding for `cloudwatch:ListManagedInsightRules` — list the
 * managed Contributor Insights rules available for a given AWS resource
 * ARN.
 *
 * Provide `CloudWatch.ListManagedInsightRulesHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Insight Rules
 * @example List Managed Rules for a Resource
 * ```typescript
 * // init — grants cloudwatch:ListManagedInsightRules
 * const listManagedInsightRules = yield* AWS.CloudWatch.ListManagedInsightRules();
 *
 * // runtime — only specific AWS resource types support managed rules;
 * // an unsupported ARN fails with the typed InvalidParameterValueException
 * const result = yield* listManagedInsightRules({
 *   ResourceARN: yield* table.tableArn,
 * });
 * const rules = result.ManagedRules ?? [];
 * ```
 */
export interface ListManagedInsightRules extends Binding.Service<
  ListManagedInsightRules,
  "AWS.CloudWatch.ListManagedInsightRules",
  () => Effect.Effect<
    (
      request?: ListManagedInsightRulesRequest,
    ) => Effect.Effect<
      cloudwatch.ListManagedInsightRulesOutput,
      cloudwatch.ListManagedInsightRulesError
    >
  >
> {}

export const ListManagedInsightRules = Binding.Service<ListManagedInsightRules>(
  "AWS.CloudWatch.ListManagedInsightRules",
);
