import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface CreateSMSSandboxPhoneNumberRequest
  extends sns.CreateSMSSandboxPhoneNumberInput {}

/**
 * Runtime binding for `sns:CreateSMSSandboxPhoneNumber`.
 *
 * An account-scoped operation — registers a destination phone number in
 * the SMS sandbox, which sends it a one-time verification code.
 * Provide the `CreateSMSSandboxPhoneNumberHttp` layer on the Function to implement the binding.
 * @binding
 * @section SMS Sandbox
 * @example Register a Sandbox Number
 * ```typescript
 * const createSandboxNumber = yield* SNS.CreateSMSSandboxPhoneNumber();
 * yield* createSandboxNumber({ PhoneNumber: "+15555550123" });
 * ```
 */
export interface CreateSMSSandboxPhoneNumber extends Binding.Service<
  CreateSMSSandboxPhoneNumber,
  "AWS.SNS.CreateSMSSandboxPhoneNumber",
  () => Effect.Effect<
    (
      request: CreateSMSSandboxPhoneNumberRequest,
    ) => Effect.Effect<
      sns.CreateSMSSandboxPhoneNumberResult,
      sns.CreateSMSSandboxPhoneNumberError
    >
  >
> {}

export const CreateSMSSandboxPhoneNumber =
  Binding.Service<CreateSMSSandboxPhoneNumber>(
    "AWS.SNS.CreateSMSSandboxPhoneNumber",
  );
