import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface OptInPhoneNumberRequest extends sns.OptInPhoneNumberInput {}

/**
 * Runtime binding for `sns:OptInPhoneNumber`.
 *
 * An account-scoped operation — opts a previously opted-out phone number
 * back in to SMS delivery (allowed once every 30 days per number).
 * Provide the `OptInPhoneNumberHttp` layer on the Function to implement the binding.
 * ### SMS Opt-Out Management
 * **Example:** Opt a Number Back In
 * ```typescript
 * const optIn = yield* SNS.OptInPhoneNumber();
 * yield* optIn({ phoneNumber: "+15555550123" });
 * ```
 *
 * @binding
 */
export interface OptInPhoneNumber extends Binding.Service<
  OptInPhoneNumber,
  "AWS.SNS.OptInPhoneNumber",
  () => Effect.Effect<
    (
      request: OptInPhoneNumberRequest,
    ) => Effect.Effect<sns.OptInPhoneNumberResponse, sns.OptInPhoneNumberError>
  >
> {}

export const OptInPhoneNumber = Binding.Service<OptInPhoneNumber>(
  "AWS.SNS.OptInPhoneNumber",
);
