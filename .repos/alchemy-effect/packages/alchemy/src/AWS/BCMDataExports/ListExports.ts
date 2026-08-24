import type * as bcm from "@distilled.cloud/aws/bcm-data-exports";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListExports}.
 */
export interface ListExportsRequest extends bcm.ListExportsRequest {}

/**
 * Runtime binding for `bcm-data-exports:ListExports`.
 *
 * An account-level operation (no export argument) that enumerates every data
 * export definition in the account. Useful for governance sweeps that audit
 * where billing data is being delivered. Provide the implementation with
 * `Effect.provide(AWS.BCMDataExports.ListExportsHttp)`.
 * @binding
 * @section Inspecting an Export
 * @example List Every Export in the Account
 * ```typescript
 * // init — account-level binding takes no resource
 * const listExports = yield* AWS.BCMDataExports.ListExports();
 *
 * // runtime
 * const result = yield* listExports({ MaxResults: 100 });
 * const names = (result.Exports ?? []).map((e) => e.ExportName);
 * ```
 */
export interface ListExports extends Binding.Service<
  ListExports,
  "AWS.BCMDataExports.ListExports",
  () => Effect.Effect<
    (
      request?: ListExportsRequest,
    ) => Effect.Effect<bcm.ListExportsResponse, bcm.ListExportsError>
  >
> {}

export const ListExports = Binding.Service<ListExports>(
  "AWS.BCMDataExports.ListExports",
);
