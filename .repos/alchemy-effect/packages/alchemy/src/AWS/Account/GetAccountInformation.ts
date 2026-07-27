import type * as account from "@distilled.cloud/aws/account";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `account:GetAccountInformation`.
 *
 * Reads the calling account's metadata — account id, account name, creation
 * date, and account state. Account Management is an account singleton, so the
 * binding takes no resource argument. Provide the implementation with
 * `Effect.provide(AWS.Account.GetAccountInformationHttp)`.
 * @binding
 * @section Reading Account Settings
 * @example Read the Account's Name and State
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getAccountInformation = yield* AWS.Account.GetAccountInformation();
 *
 * // runtime
 * const info = yield* getAccountInformation();
 * console.log(info.AccountId, info.AccountState);
 * ```
 */
export interface GetAccountInformation extends Binding.Service<
  GetAccountInformation,
  "AWS.Account.GetAccountInformation",
  () => Effect.Effect<
    (
      request?: account.GetAccountInformationRequest,
    ) => Effect.Effect<
      account.GetAccountInformationResponse,
      account.GetAccountInformationError
    >
  >
> {}
export const GetAccountInformation = Binding.Service<GetAccountInformation>(
  "AWS.Account.GetAccountInformation",
);
