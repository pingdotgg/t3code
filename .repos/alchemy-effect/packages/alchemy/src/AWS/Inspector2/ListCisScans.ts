import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:ListCisScans`.
 *
 * Returns a CIS scan list.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListCisScansHttp)`.
 * @binding
 * @section CIS Scan Results
 * @example List Completed CIS Scans
 * ```typescript
 * // init
 * const listCisScans = yield* AWS.Inspector2.ListCisScans();
 *
 * // runtime
 * const { scans } = yield* listCisScans();
 * ```
 */
export interface ListCisScans extends Binding.Service<
  ListCisScans,
  "AWS.Inspector2.ListCisScans",
  () => Effect.Effect<
    (
      request?: inspector2.ListCisScansRequest,
    ) => Effect.Effect<
      inspector2.ListCisScansResponse,
      inspector2.ListCisScansError
    >
  >
> {}
export const ListCisScans = Binding.Service<ListCisScans>(
  "AWS.Inspector2.ListCisScans",
);
