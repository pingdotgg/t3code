import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListCustomDataIdentifiers`.
 *
 * Retrieves a subset of information about the custom data identifiers for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListCustomDataIdentifiersHttp)`.
 * @binding
 * @section Custom Data Identifiers & Lists
 * @example List Custom Data Identifiers
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listCustomDataIdentifiers = yield* AWS.Macie2.ListCustomDataIdentifiers();
 *
 * // runtime
 * const { items } = yield* listCustomDataIdentifiers();
 * ```
 */
export interface ListCustomDataIdentifiers extends Binding.Service<
  ListCustomDataIdentifiers,
  "AWS.Macie2.ListCustomDataIdentifiers",
  () => Effect.Effect<
    (
      request?: macie2.ListCustomDataIdentifiersRequest,
    ) => Effect.Effect<
      macie2.ListCustomDataIdentifiersResponse,
      macie2.ListCustomDataIdentifiersError
    >
  >
> {}
export const ListCustomDataIdentifiers =
  Binding.Service<ListCustomDataIdentifiers>(
    "AWS.Macie2.ListCustomDataIdentifiers",
  );
