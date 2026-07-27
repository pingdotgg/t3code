import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:ListFindings`.
 *
 * Lists findings for your environment.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListFindingsHttp)`.
 * @binding
 * @section Querying Findings
 * @example List Critical Findings
 * ```typescript
 * // init
 * const listFindings = yield* AWS.Inspector2.ListFindings();
 *
 * // runtime
 * const { findings } = yield* listFindings({
 *   filterCriteria: { severity: [{ comparison: "EQUALS", value: "CRITICAL" }] },
 * });
 * ```
 */
export interface ListFindings extends Binding.Service<
  ListFindings,
  "AWS.Inspector2.ListFindings",
  () => Effect.Effect<
    (
      request?: inspector2.ListFindingsRequest,
    ) => Effect.Effect<
      inspector2.ListFindingsResponse,
      inspector2.ListFindingsError
    >
  >
> {}
export const ListFindings = Binding.Service<ListFindings>(
  "AWS.Inspector2.ListFindings",
);
