import type * as account from "@distilled.cloud/aws/account";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `account:GetContactInformation`.
 *
 * Reads the calling account's primary contact — full name, address, phone
 * number, and company. The contact fields are marked sensitive at the wire
 * level, so distilled returns them as `string | Redacted<string>`. Account
 * Management is an account singleton, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.Account.GetContactInformationHttp)`.
 * @binding
 * @section Reading Account Settings
 * @example Read the Primary Contact
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getContactInformation = yield* AWS.Account.GetContactInformation();
 *
 * // runtime
 * const { ContactInformation } = yield* getContactInformation();
 * console.log(ContactInformation?.CountryCode);
 * ```
 */
export interface GetContactInformation extends Binding.Service<
  GetContactInformation,
  "AWS.Account.GetContactInformation",
  () => Effect.Effect<
    (
      request?: account.GetContactInformationRequest,
    ) => Effect.Effect<
      account.GetContactInformationResponse,
      account.GetContactInformationError
    >
  >
> {}
export const GetContactInformation = Binding.Service<GetContactInformation>(
  "AWS.Account.GetContactInformation",
);
