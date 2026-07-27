import type * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PhoneNumber } from "./PhoneNumber.ts";

/**
 * The `OriginationIdentity` is injected by the binding from the bound
 * phone number; the caller may filter by keyword or page with `NextToken`.
 */
export interface DescribeKeywordsRequest extends Omit<
  smsvoice.DescribeKeywordsRequest,
  "OriginationIdentity"
> {}

/**
 * Runtime binding for `sms-voice:DescribeKeywords`.
 *
 * Lists the keywords configured on the bound origination phone number
 * (one page per call — pass `NextToken` from the previous response to
 * continue). The deploy-time half grants `sms-voice:DescribeKeywords` on
 * the number. Provide the implementation with
 * `Effect.provide(AWS.PinpointSMSVoiceV2.DescribeKeywordsHttp)`.
 * @binding
 * @section Managing Keywords
 * @example List the Number's Keywords
 * ```typescript
 * // init
 * const describeKeywords =
 *   yield* AWS.PinpointSMSVoiceV2.DescribeKeywords(number);
 *
 * // runtime
 * const { Keywords } = yield* describeKeywords({});
 * const info = (Keywords ?? []).find((k) => k.Keyword === "INFO");
 * ```
 */
export interface DescribeKeywords extends Binding.Service<
  DescribeKeywords,
  "AWS.PinpointSMSVoiceV2.DescribeKeywords",
  (
    phoneNumber: PhoneNumber,
  ) => Effect.Effect<
    (
      request: DescribeKeywordsRequest,
    ) => Effect.Effect<
      smsvoice.DescribeKeywordsResult,
      smsvoice.DescribeKeywordsError
    >
  >
> {}
export const DescribeKeywords = Binding.Service<DescribeKeywords>(
  "AWS.PinpointSMSVoiceV2.DescribeKeywords",
);
