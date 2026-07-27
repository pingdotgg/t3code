import type * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PhoneNumber } from "./PhoneNumber.ts";

/**
 * The `OriginationIdentity` is injected by the binding from the bound
 * phone number; the caller supplies the keyword and its response message.
 */
export interface PutKeywordRequest extends Omit<
  smsvoice.PutKeywordRequest,
  "OriginationIdentity"
> {}

/**
 * Runtime binding for `sms-voice:PutKeyword`.
 *
 * Creates or updates a keyword on the bound origination phone number —
 * when an end user texts the keyword to the number, End User Messaging
 * SMS automatically replies with `KeywordMessage` (or opts them out /
 * back in when `KeywordAction` is set). The deploy-time half grants
 * `sms-voice:PutKeyword` on the number. Provide the implementation with
 * `Effect.provide(AWS.PinpointSMSVoiceV2.PutKeywordHttp)`.
 * @binding
 * @section Managing Keywords
 * @example Register an Auto-Reply Keyword
 * ```typescript
 * // init
 * const putKeyword = yield* AWS.PinpointSMSVoiceV2.PutKeyword(number);
 *
 * // runtime
 * yield* putKeyword({
 *   Keyword: "INFO",
 *   KeywordMessage: "Visit https://example.com for details.",
 * });
 * ```
 */
export interface PutKeyword extends Binding.Service<
  PutKeyword,
  "AWS.PinpointSMSVoiceV2.PutKeyword",
  (
    phoneNumber: PhoneNumber,
  ) => Effect.Effect<
    (
      request: PutKeywordRequest,
    ) => Effect.Effect<smsvoice.PutKeywordResult, smsvoice.PutKeywordError>
  >
> {}
export const PutKeyword = Binding.Service<PutKeyword>(
  "AWS.PinpointSMSVoiceV2.PutKeyword",
);
