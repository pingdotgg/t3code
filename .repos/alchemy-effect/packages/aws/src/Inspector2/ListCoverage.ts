import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `inspector2:ListCoverage`.
 *
 * Lists coverage details for your environment.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListCoverageHttp)`.
 * ### Coverage & Vulnerability Intel
 * **Example:** List Scan Coverage
 * ```typescript
 * // init
 * const listCoverage = yield* AWS.Inspector2.ListCoverage();
 *
 * // runtime
 * const { coveredResources } = yield* listCoverage();
 * ```
 *
 * @binding
 */
export interface ListCoverage extends Binding.Service<
  ListCoverage,
  "AWS.Inspector2.ListCoverage",
  () => Effect.Effect<
    (
      request?: inspector2.ListCoverageRequest,
    ) => Effect.Effect<inspector2.ListCoverageResponse, inspector2.ListCoverageError>
  >
> {}
export const ListCoverage = Binding.Service<ListCoverage>("AWS.Inspector2.ListCoverage");
