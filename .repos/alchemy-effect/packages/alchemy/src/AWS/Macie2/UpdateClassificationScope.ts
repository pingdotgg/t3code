import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:UpdateClassificationScope`.
 *
 * Updates the classification scope settings for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.UpdateClassificationScopeHttp)`.
 * @binding
 * @section Automated Discovery
 * @example Exclude Buckets from Automated Discovery
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateClassificationScope = yield* AWS.Macie2.UpdateClassificationScope();
 *
 * // runtime
 * yield* updateClassificationScope({
 *   id: scopeId,
 *   s3: { excludes: { bucketNames: ["logs-bucket"], operation: "ADD" } },
 * });
 * ```
 */
export interface UpdateClassificationScope extends Binding.Service<
  UpdateClassificationScope,
  "AWS.Macie2.UpdateClassificationScope",
  () => Effect.Effect<
    (
      request: macie2.UpdateClassificationScopeRequest,
    ) => Effect.Effect<
      macie2.UpdateClassificationScopeResponse,
      macie2.UpdateClassificationScopeError
    >
  >
> {}
export const UpdateClassificationScope =
  Binding.Service<UpdateClassificationScope>(
    "AWS.Macie2.UpdateClassificationScope",
  );
