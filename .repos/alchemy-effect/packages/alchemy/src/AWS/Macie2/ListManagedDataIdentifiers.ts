import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListManagedDataIdentifiers`.
 *
 * Retrieves information about all the managed data identifiers that Amazon Macie currently provides.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListManagedDataIdentifiersHttp)`.
 * @binding
 * @section Custom Data Identifiers & Lists
 * @example List Managed Data Identifiers
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listManagedDataIdentifiers = yield* AWS.Macie2.ListManagedDataIdentifiers();
 *
 * // runtime
 * const { items } = yield* listManagedDataIdentifiers();
 * ```
 */
export interface ListManagedDataIdentifiers extends Binding.Service<
  ListManagedDataIdentifiers,
  "AWS.Macie2.ListManagedDataIdentifiers",
  () => Effect.Effect<
    (
      request?: macie2.ListManagedDataIdentifiersRequest,
    ) => Effect.Effect<
      macie2.ListManagedDataIdentifiersResponse,
      macie2.ListManagedDataIdentifiersError
    >
  >
> {}
export const ListManagedDataIdentifiers =
  Binding.Service<ListManagedDataIdentifiers>(
    "AWS.Macie2.ListManagedDataIdentifiers",
  );
