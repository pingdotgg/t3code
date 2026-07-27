import type * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { OptOutList } from "./OptOutList.ts";

/**
 * The `OptOutListName` is injected by the binding from the bound opt-out
 * list; the caller supplies the destination number to opt out.
 */
export interface PutOptedOutNumberRequest extends Omit<
  smsvoice.PutOptedOutNumberRequest,
  "OptOutListName"
> {}

/**
 * Runtime binding for `sms-voice:PutOptedOutNumber`.
 *
 * Adds a destination phone number to the bound opt-out list — further
 * messages to it through numbers using this list are suppressed. Use it
 * to honor opt-out requests arriving through channels other than the
 * carrier keywords (support tickets, web forms). The deploy-time half
 * grants `sms-voice:PutOptedOutNumber` on the list. Provide the
 * implementation with
 * `Effect.provide(AWS.PinpointSMSVoiceV2.PutOptedOutNumberHttp)`.
 * @binding
 * @section Managing Opt-Outs
 * @example Opt a Number Out from a Lambda
 * ```typescript
 * // init
 * const optOuts = yield* AWS.PinpointSMSVoiceV2.OptOutList("OptOuts");
 * const putOptedOut = yield* AWS.PinpointSMSVoiceV2.PutOptedOutNumber(optOuts);
 *
 * // runtime
 * yield* putOptedOut({ OptedOutNumber: "+12065550100" });
 * ```
 */
export interface PutOptedOutNumber extends Binding.Service<
  PutOptedOutNumber,
  "AWS.PinpointSMSVoiceV2.PutOptedOutNumber",
  (
    optOutList: OptOutList,
  ) => Effect.Effect<
    (
      request: PutOptedOutNumberRequest,
    ) => Effect.Effect<
      smsvoice.PutOptedOutNumberResult,
      smsvoice.PutOptedOutNumberError
    >
  >
> {}
export const PutOptedOutNumber = Binding.Service<PutOptedOutNumber>(
  "AWS.PinpointSMSVoiceV2.PutOptedOutNumber",
);
