import type * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { OptOutList } from "./OptOutList.ts";

/**
 * The `OptOutListName` is injected by the binding from the bound opt-out
 * list; the caller supplies the destination number to opt back in.
 */
export interface DeleteOptedOutNumberRequest extends Omit<
  smsvoice.DeleteOptedOutNumberRequest,
  "OptOutListName"
> {}

/**
 * Runtime binding for `sms-voice:DeleteOptedOutNumber`.
 *
 * Removes a destination phone number from the bound opt-out list, opting
 * the end user back in to receiving messages. Numbers that opted
 * themselves out by replying with a keyword can only be removed once
 * every 30 days. The deploy-time half grants
 * `sms-voice:DeleteOptedOutNumber` on the list. Provide the
 * implementation with
 * `Effect.provide(AWS.PinpointSMSVoiceV2.DeleteOptedOutNumberHttp)`.
 * @binding
 * @section Managing Opt-Outs
 * @example Opt a Number Back In
 * ```typescript
 * // init
 * const deleteOptedOut =
 *   yield* AWS.PinpointSMSVoiceV2.DeleteOptedOutNumber(optOuts);
 *
 * // runtime
 * yield* deleteOptedOut({ OptedOutNumber: "+12065550100" });
 * ```
 */
export interface DeleteOptedOutNumber extends Binding.Service<
  DeleteOptedOutNumber,
  "AWS.PinpointSMSVoiceV2.DeleteOptedOutNumber",
  (
    optOutList: OptOutList,
  ) => Effect.Effect<
    (
      request: DeleteOptedOutNumberRequest,
    ) => Effect.Effect<
      smsvoice.DeleteOptedOutNumberResult,
      smsvoice.DeleteOptedOutNumberError
    >
  >
> {}
export const DeleteOptedOutNumber = Binding.Service<DeleteOptedOutNumber>(
  "AWS.PinpointSMSVoiceV2.DeleteOptedOutNumber",
);
