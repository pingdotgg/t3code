import type * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PhoneNumber } from "./PhoneNumber.ts";

/**
 * The `OriginationIdentity` is injected by the binding from the bound
 * phone number; the caller supplies the keyword to remove.
 */
export interface DeleteKeywordRequest extends Omit<
  smsvoice.DeleteKeywordRequest,
  "OriginationIdentity"
> {}

/**
 * Runtime binding for `sms-voice:DeleteKeyword`.
 *
 * Deletes a keyword from the bound origination phone number. Keywords
 * `HELP` and `STOP` cannot be deleted (they are carrier-mandated). The
 * deploy-time half grants `sms-voice:DeleteKeyword` on the number.
 * Provide the implementation with
 * `Effect.provide(AWS.PinpointSMSVoiceV2.DeleteKeywordHttp)`.
 * @binding
 * @section Managing Keywords
 * @example Remove a Keyword
 * ```typescript
 * // init
 * const deleteKeyword = yield* AWS.PinpointSMSVoiceV2.DeleteKeyword(number);
 *
 * // runtime
 * yield* deleteKeyword({ Keyword: "INFO" });
 * ```
 */
export interface DeleteKeyword extends Binding.Service<
  DeleteKeyword,
  "AWS.PinpointSMSVoiceV2.DeleteKeyword",
  (
    phoneNumber: PhoneNumber,
  ) => Effect.Effect<
    (
      request: DeleteKeywordRequest,
    ) => Effect.Effect<
      smsvoice.DeleteKeywordResult,
      smsvoice.DeleteKeywordError
    >
  >
> {}
export const DeleteKeyword = Binding.Service<DeleteKeyword>(
  "AWS.PinpointSMSVoiceV2.DeleteKeyword",
);
