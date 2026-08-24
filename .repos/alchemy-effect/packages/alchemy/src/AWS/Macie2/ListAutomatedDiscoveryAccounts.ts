import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListAutomatedDiscoveryAccounts`.
 *
 * Retrieves the status of automated sensitive data discovery for one or more accounts.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListAutomatedDiscoveryAccountsHttp)`.
 * @binding
 * @section Automated Discovery
 * @example List Automated Discovery Accounts
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listAutomatedDiscoveryAccounts = yield* AWS.Macie2.ListAutomatedDiscoveryAccounts();
 *
 * // runtime
 * const { items } = yield* listAutomatedDiscoveryAccounts();
 * ```
 */
export interface ListAutomatedDiscoveryAccounts extends Binding.Service<
  ListAutomatedDiscoveryAccounts,
  "AWS.Macie2.ListAutomatedDiscoveryAccounts",
  () => Effect.Effect<
    (
      request?: macie2.ListAutomatedDiscoveryAccountsRequest,
    ) => Effect.Effect<
      macie2.ListAutomatedDiscoveryAccountsResponse,
      macie2.ListAutomatedDiscoveryAccountsError
    >
  >
> {}
export const ListAutomatedDiscoveryAccounts =
  Binding.Service<ListAutomatedDiscoveryAccounts>(
    "AWS.Macie2.ListAutomatedDiscoveryAccounts",
  );
