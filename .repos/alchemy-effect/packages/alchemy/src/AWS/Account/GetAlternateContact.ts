import type * as account from "@distilled.cloud/aws/account";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `account:GetAlternateContact`.
 *
 * Reads one of the calling account's alternate contacts (`BILLING`,
 * `OPERATIONS`, or `SECURITY`). When the requested contact type has never
 * been set, the operation fails with the typed
 * `ResourceNotFoundException`. Account Management is an account singleton,
 * so the binding takes no resource argument. Provide the implementation with
 * `Effect.provide(AWS.Account.GetAlternateContactHttp)`.
 * @binding
 * @section Reading Account Settings
 * @example Read the Billing Contact
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getAlternateContact = yield* AWS.Account.GetAlternateContact();
 *
 * // runtime
 * const billing = yield* getAlternateContact({
 *   AlternateContactType: "BILLING",
 * }).pipe(
 *   Effect.catchTag("ResourceNotFoundException", () =>
 *     Effect.succeed({ AlternateContact: undefined }),
 *   ),
 * );
 * ```
 */
export interface GetAlternateContact extends Binding.Service<
  GetAlternateContact,
  "AWS.Account.GetAlternateContact",
  () => Effect.Effect<
    (
      request: account.GetAlternateContactRequest,
    ) => Effect.Effect<
      account.GetAlternateContactResponse,
      account.GetAlternateContactError
    >
  >
> {}
export const GetAlternateContact = Binding.Service<GetAlternateContact>(
  "AWS.Account.GetAlternateContact",
);
