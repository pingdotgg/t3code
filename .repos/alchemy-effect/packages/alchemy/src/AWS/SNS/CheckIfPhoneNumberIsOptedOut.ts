import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface CheckIfPhoneNumberIsOptedOutRequest
  extends sns.CheckIfPhoneNumberIsOptedOutInput {}

/**
 * Runtime binding for `sns:CheckIfPhoneNumberIsOptedOut`.
 *
 * An account-scoped operation — reports whether SMS delivery to a phone
 * number is blocked because its owner opted out.
 * Provide the `CheckIfPhoneNumberIsOptedOutHttp` layer on the Function to implement the binding.
 * @binding
 * @section SMS Opt-Out Management
 * @example Check an Opt-Out
 * ```typescript
 * const checkOptOut = yield* SNS.CheckIfPhoneNumberIsOptedOut();
 * const { isOptedOut } = yield* checkOptOut({ phoneNumber: "+15555550123" });
 * ```
 */
export interface CheckIfPhoneNumberIsOptedOut extends Binding.Service<
  CheckIfPhoneNumberIsOptedOut,
  "AWS.SNS.CheckIfPhoneNumberIsOptedOut",
  () => Effect.Effect<
    (
      request: CheckIfPhoneNumberIsOptedOutRequest,
    ) => Effect.Effect<
      sns.CheckIfPhoneNumberIsOptedOutResponse,
      sns.CheckIfPhoneNumberIsOptedOutError
    >
  >
> {}

export const CheckIfPhoneNumberIsOptedOut =
  Binding.Service<CheckIfPhoneNumberIsOptedOut>(
    "AWS.SNS.CheckIfPhoneNumberIsOptedOut",
  );
