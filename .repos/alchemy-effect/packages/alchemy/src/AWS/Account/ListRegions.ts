import type * as account from "@distilled.cloud/aws/account";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `account:ListRegions`.
 *
 * Lists every Region available to the calling account together with its
 * opt-in status (`ENABLED`, `DISABLED`, `ENABLED_BY_DEFAULT`, …), optionally
 * filtered by `RegionOptStatusContains`. Account Management is an account
 * singleton, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Account.ListRegionsHttp)`.
 * @binding
 * @section Reading Region Opt Status
 * @example List the Enabled-by-Default Regions
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listRegions = yield* AWS.Account.ListRegions();
 *
 * // runtime
 * const { Regions } = yield* listRegions({
 *   RegionOptStatusContains: ["ENABLED_BY_DEFAULT"],
 * });
 * for (const region of Regions ?? []) {
 *   console.log(region.RegionName, region.RegionOptStatus);
 * }
 * ```
 */
export interface ListRegions extends Binding.Service<
  ListRegions,
  "AWS.Account.ListRegions",
  () => Effect.Effect<
    (
      request?: account.ListRegionsRequest,
    ) => Effect.Effect<account.ListRegionsResponse, account.ListRegionsError>
  >
> {}
export const ListRegions = Binding.Service<ListRegions>(
  "AWS.Account.ListRegions",
);
