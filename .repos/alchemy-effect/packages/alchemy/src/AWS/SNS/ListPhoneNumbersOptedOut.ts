import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListPhoneNumbersOptedOutRequest
  extends sns.ListPhoneNumbersOptedOutInput {}

/**
 * Runtime binding for `sns:ListPhoneNumbersOptedOut`.
 *
 * An account-scoped operation — pages through the phone numbers whose
 * owners opted out of receiving SMS from this account.
 * Provide the `ListPhoneNumbersOptedOutHttp` layer on the Function to implement the binding.
 * @binding
 * @section SMS Opt-Out Management
 * @example List Opted-Out Numbers
 * ```typescript
 * const listOptedOut = yield* SNS.ListPhoneNumbersOptedOut();
 * const { phoneNumbers } = yield* listOptedOut();
 * ```
 */
export interface ListPhoneNumbersOptedOut extends Binding.Service<
  ListPhoneNumbersOptedOut,
  "AWS.SNS.ListPhoneNumbersOptedOut",
  () => Effect.Effect<
    (
      request?: ListPhoneNumbersOptedOutRequest,
    ) => Effect.Effect<
      sns.ListPhoneNumbersOptedOutResponse,
      sns.ListPhoneNumbersOptedOutError
    >
  >
> {}

export const ListPhoneNumbersOptedOut =
  Binding.Service<ListPhoneNumbersOptedOut>("AWS.SNS.ListPhoneNumbersOptedOut");
