import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface VerifySMSSandboxPhoneNumberRequest
  extends sns.VerifySMSSandboxPhoneNumberInput {}

/**
 * Runtime binding for `sns:VerifySMSSandboxPhoneNumber`.
 *
 * An account-scoped operation — verifies a sandbox destination phone
 * number with the one-time password SNS texted to it.
 * Provide the `VerifySMSSandboxPhoneNumberHttp` layer on the Function to implement the binding.
 * @binding
 * @section SMS Sandbox
 * @example Verify a Sandbox Number
 * ```typescript
 * const verifySandboxNumber = yield* SNS.VerifySMSSandboxPhoneNumber();
 * yield* verifySandboxNumber({
 *   PhoneNumber: "+15555550123",
 *   OneTimePassword: "123456",
 * });
 * ```
 */
export interface VerifySMSSandboxPhoneNumber extends Binding.Service<
  VerifySMSSandboxPhoneNumber,
  "AWS.SNS.VerifySMSSandboxPhoneNumber",
  () => Effect.Effect<
    (
      request: VerifySMSSandboxPhoneNumberRequest,
    ) => Effect.Effect<
      sns.VerifySMSSandboxPhoneNumberResult,
      sns.VerifySMSSandboxPhoneNumberError
    >
  >
> {}

export const VerifySMSSandboxPhoneNumber =
  Binding.Service<VerifySMSSandboxPhoneNumber>(
    "AWS.SNS.VerifySMSSandboxPhoneNumber",
  );
