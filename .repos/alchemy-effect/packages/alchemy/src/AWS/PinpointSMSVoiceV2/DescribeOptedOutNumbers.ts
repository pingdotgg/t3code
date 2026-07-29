import type * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { OptOutList } from "./OptOutList.ts";

/**
 * The `OptOutListName` is injected by the binding from the bound opt-out
 * list; the caller may filter by number or page with `NextToken`.
 */
export interface DescribeOptedOutNumbersRequest extends Omit<
  smsvoice.DescribeOptedOutNumbersRequest,
  "OptOutListName"
> {}

/**
 * Runtime binding for `sms-voice:DescribeOptedOutNumbers`.
 *
 * Lists the opted-out destination numbers in the bound opt-out list (one
 * page per call — pass `NextToken` from the previous response to
 * continue). Use it to check whether a number opted out before sending.
 * The deploy-time half grants `sms-voice:DescribeOptedOutNumbers` on the
 * list. Provide the implementation with
 * `Effect.provide(AWS.PinpointSMSVoiceV2.DescribeOptedOutNumbersHttp)`.
 * @binding
 * @section Managing Opt-Outs
 * @example Check a Number Before Sending
 * ```typescript
 * // init
 * const describeOptedOut =
 *   yield* AWS.PinpointSMSVoiceV2.DescribeOptedOutNumbers(optOuts);
 *
 * // runtime
 * const { OptedOutNumbers } = yield* describeOptedOut({
 *   OptedOutNumbers: ["+12065550100"],
 * });
 * const optedOut = (OptedOutNumbers ?? []).length > 0;
 * ```
 */
export interface DescribeOptedOutNumbers extends Binding.Service<
  DescribeOptedOutNumbers,
  "AWS.PinpointSMSVoiceV2.DescribeOptedOutNumbers",
  (
    optOutList: OptOutList,
  ) => Effect.Effect<
    (
      request: DescribeOptedOutNumbersRequest,
    ) => Effect.Effect<
      smsvoice.DescribeOptedOutNumbersResult,
      smsvoice.DescribeOptedOutNumbersError
    >
  >
> {}
export const DescribeOptedOutNumbers = Binding.Service<DescribeOptedOutNumbers>(
  "AWS.PinpointSMSVoiceV2.DescribeOptedOutNumbers",
);
