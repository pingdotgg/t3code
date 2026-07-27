import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:ListAutomationRules`.
 *
 * Lists the automation rules defined in the account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.ListAutomationRulesHttp)`.
 * @binding
 * @section Custom Actions, Automation Rules & Aggregation
 * @example List Automation Rules
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listAutomationRules = yield* AWS.SecurityHub.ListAutomationRules();
 *
 * // runtime
 * const { AutomationRulesMetadata } = yield* listAutomationRules();
 * ```
 */
export interface ListAutomationRules extends Binding.Service<
  ListAutomationRules,
  "AWS.SecurityHub.ListAutomationRules",
  () => Effect.Effect<
    (
      request?: securityhub.ListAutomationRulesRequest,
    ) => Effect.Effect<
      securityhub.ListAutomationRulesResponse,
      securityhub.ListAutomationRulesError
    >
  >
> {}
export const ListAutomationRules = Binding.Service<ListAutomationRules>(
  "AWS.SecurityHub.ListAutomationRules",
);
