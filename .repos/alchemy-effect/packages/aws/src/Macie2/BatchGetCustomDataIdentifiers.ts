import type * as macie2 from "@distilled.cloud/aws/macie2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `macie2:BatchGetCustomDataIdentifiers`.
 *
 * Retrieves information about one or more custom data identifiers.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.BatchGetCustomDataIdentifiersHttp)`.
 * ### Custom Data Identifiers & Lists
 * **Example:** Hydrate Custom Data Identifiers
 * ```typescript
 * // init — account-level binding, no resource argument
 * const batchGetCustomDataIdentifiers = yield* AWS.Macie2.BatchGetCustomDataIdentifiers();
 *
 * // runtime
 * const { customDataIdentifiers } = yield* batchGetCustomDataIdentifiers({ ids });
 * ```
 *
 * @binding
 */
export interface BatchGetCustomDataIdentifiers extends Binding.Service<
  BatchGetCustomDataIdentifiers,
  "AWS.Macie2.BatchGetCustomDataIdentifiers",
  () => Effect.Effect<
    (
      request?: macie2.BatchGetCustomDataIdentifiersRequest,
    ) => Effect.Effect<
      macie2.BatchGetCustomDataIdentifiersResponse,
      macie2.BatchGetCustomDataIdentifiersError
    >
  >
> {}
export const BatchGetCustomDataIdentifiers = Binding.Service<BatchGetCustomDataIdentifiers>(
  "AWS.Macie2.BatchGetCustomDataIdentifiers",
);
