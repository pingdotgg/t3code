import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListClassificationScopes`.
 *
 * Retrieves a subset of information about the classification scope for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListClassificationScopesHttp)`.
 * @binding
 * @section Automated Discovery
 * @example List Classification Scopes
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listClassificationScopes = yield* AWS.Macie2.ListClassificationScopes();
 *
 * // runtime
 * const { classificationScopes } = yield* listClassificationScopes();
 * ```
 */
export interface ListClassificationScopes extends Binding.Service<
  ListClassificationScopes,
  "AWS.Macie2.ListClassificationScopes",
  () => Effect.Effect<
    (
      request?: macie2.ListClassificationScopesRequest,
    ) => Effect.Effect<
      macie2.ListClassificationScopesResponse,
      macie2.ListClassificationScopesError
    >
  >
> {}
export const ListClassificationScopes =
  Binding.Service<ListClassificationScopes>(
    "AWS.Macie2.ListClassificationScopes",
  );
