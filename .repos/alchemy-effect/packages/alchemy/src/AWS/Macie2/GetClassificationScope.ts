import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetClassificationScope`.
 *
 * Retrieves the classification scope settings for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetClassificationScopeHttp)`.
 * @binding
 * @section Automated Discovery
 * @example Read a Classification Scope
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getClassificationScope = yield* AWS.Macie2.GetClassificationScope();
 *
 * // runtime
 * const scope = yield* getClassificationScope({ id: scopeId });
 * ```
 */
export interface GetClassificationScope extends Binding.Service<
  GetClassificationScope,
  "AWS.Macie2.GetClassificationScope",
  () => Effect.Effect<
    (
      request: macie2.GetClassificationScopeRequest,
    ) => Effect.Effect<
      macie2.GetClassificationScopeResponse,
      macie2.GetClassificationScopeError
    >
  >
> {}
export const GetClassificationScope = Binding.Service<GetClassificationScope>(
  "AWS.Macie2.GetClassificationScope",
);
