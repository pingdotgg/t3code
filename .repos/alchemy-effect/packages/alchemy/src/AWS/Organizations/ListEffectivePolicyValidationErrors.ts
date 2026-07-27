import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListEffectivePolicyValidationErrors`.
 *
 * Lists the validation errors in an account's effective policy of the specified type — the reasons the aggregated policy is invalid.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListEffectivePolicyValidationErrorsHttp)`.
 * @binding
 * @section Policies & Effective Policy
 * @example Read Effective-Policy Validation Errors
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listEffectivePolicyValidationErrors = yield* AWS.Organizations.ListEffectivePolicyValidationErrors();
 *
 * // runtime
 * const { EffectivePolicyValidationErrors } =
 *   yield* listEffectivePolicyValidationErrors({
 *     AccountId: accountId,
 *     PolicyType: "TAG_POLICY",
 *   });
 * ```
 */
export interface ListEffectivePolicyValidationErrors extends Binding.Service<
  ListEffectivePolicyValidationErrors,
  "AWS.Organizations.ListEffectivePolicyValidationErrors",
  () => Effect.Effect<
    (
      request: organizations.ListEffectivePolicyValidationErrorsRequest,
    ) => Effect.Effect<
      organizations.ListEffectivePolicyValidationErrorsResponse,
      organizations.ListEffectivePolicyValidationErrorsError
    >
  >
> {}
export const ListEffectivePolicyValidationErrors =
  Binding.Service<ListEffectivePolicyValidationErrors>(
    "AWS.Organizations.ListEffectivePolicyValidationErrors",
  );
