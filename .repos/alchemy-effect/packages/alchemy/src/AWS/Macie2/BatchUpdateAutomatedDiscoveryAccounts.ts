import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:BatchUpdateAutomatedDiscoveryAccounts`.
 *
 * Changes the status of automated sensitive data discovery for one or more accounts.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.BatchUpdateAutomatedDiscoveryAccountsHttp)`.
 * @binding
 * @section Automated Discovery
 * @example Toggle Automated Discovery per Account
 * ```typescript
 * // init — account-level binding, no resource argument
 * const batchUpdateAutomatedDiscoveryAccounts = yield* AWS.Macie2.BatchUpdateAutomatedDiscoveryAccounts();
 *
 * // runtime
 * yield* batchUpdateAutomatedDiscoveryAccounts({
 *   accounts: [{ accountId, status: "ENABLED" }],
 * });
 * ```
 */
export interface BatchUpdateAutomatedDiscoveryAccounts extends Binding.Service<
  BatchUpdateAutomatedDiscoveryAccounts,
  "AWS.Macie2.BatchUpdateAutomatedDiscoveryAccounts",
  () => Effect.Effect<
    (
      request?: macie2.BatchUpdateAutomatedDiscoveryAccountsRequest,
    ) => Effect.Effect<
      macie2.BatchUpdateAutomatedDiscoveryAccountsResponse,
      macie2.BatchUpdateAutomatedDiscoveryAccountsError
    >
  >
> {}
export const BatchUpdateAutomatedDiscoveryAccounts =
  Binding.Service<BatchUpdateAutomatedDiscoveryAccounts>(
    "AWS.Macie2.BatchUpdateAutomatedDiscoveryAccounts",
  );
