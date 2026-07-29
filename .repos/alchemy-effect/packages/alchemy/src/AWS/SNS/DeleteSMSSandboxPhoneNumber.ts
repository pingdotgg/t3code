import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DeleteSMSSandboxPhoneNumberRequest
  extends sns.DeleteSMSSandboxPhoneNumberInput {}

/**
 * Runtime binding for `sns:DeleteSMSSandboxPhoneNumber`.
 *
 * An account-scoped operation — removes a destination phone number from
 * the account's SMS sandbox.
 * Provide the `DeleteSMSSandboxPhoneNumberHttp` layer on the Function to implement the binding.
 * @binding
 * @section SMS Sandbox
 * @example Delete a Sandbox Number
 * ```typescript
 * const deleteSandboxNumber = yield* SNS.DeleteSMSSandboxPhoneNumber();
 * yield* deleteSandboxNumber({ PhoneNumber: "+15555550123" });
 * ```
 */
export interface DeleteSMSSandboxPhoneNumber extends Binding.Service<
  DeleteSMSSandboxPhoneNumber,
  "AWS.SNS.DeleteSMSSandboxPhoneNumber",
  () => Effect.Effect<
    (
      request: DeleteSMSSandboxPhoneNumberRequest,
    ) => Effect.Effect<
      sns.DeleteSMSSandboxPhoneNumberResult,
      sns.DeleteSMSSandboxPhoneNumberError
    >
  >
> {}

export const DeleteSMSSandboxPhoneNumber =
  Binding.Service<DeleteSMSSandboxPhoneNumber>(
    "AWS.SNS.DeleteSMSSandboxPhoneNumber",
  );
