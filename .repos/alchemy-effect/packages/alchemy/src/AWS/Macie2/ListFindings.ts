import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListFindings`.
 *
 * Retrieves a subset of information about one or more findings.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListFindingsHttp)`.
 * @binding
 * @section Working with Findings
 * @example List Finding Ids
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listFindings = yield* AWS.Macie2.ListFindings();
 *
 * // runtime
 * const { findingIds } = yield* listFindings();
 * ```
 */
export interface ListFindings extends Binding.Service<
  ListFindings,
  "AWS.Macie2.ListFindings",
  () => Effect.Effect<
    (
      request?: macie2.ListFindingsRequest,
    ) => Effect.Effect<macie2.ListFindingsResponse, macie2.ListFindingsError>
  >
> {}
export const ListFindings = Binding.Service<ListFindings>(
  "AWS.Macie2.ListFindings",
);
