import type * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `sms-voice:CarrierLookup`.
 *
 * Looks up carrier metadata for a destination phone number — its E.164
 * normalization, country, carrier name, and number type (`MOBILE`,
 * `LANDLINE`, `VOIP`, …). Use it to validate destinations before
 * sending. Account-level: lookups act on raw phone numbers, so the
 * deploy-time grant is `sms-voice:CarrierLookup` on `*`. Each lookup
 * incurs a small per-request fee. Provide the implementation with
 * `Effect.provide(AWS.PinpointSMSVoiceV2.CarrierLookupHttp)`.
 * @binding
 * @section Validating Destinations
 * @example Check a Number Before Sending
 * ```typescript
 * // init — bind the account-level operation
 * const carrierLookup = yield* AWS.PinpointSMSVoiceV2.CarrierLookup();
 *
 * // runtime
 * const info = yield* carrierLookup({ PhoneNumber: "+12065550100" });
 * const isMobile = info.PhoneNumberType === "MOBILE";
 * ```
 */
export interface CarrierLookup extends Binding.Service<
  CarrierLookup,
  "AWS.PinpointSMSVoiceV2.CarrierLookup",
  () => Effect.Effect<
    (
      request: smsvoice.CarrierLookupRequest,
    ) => Effect.Effect<
      smsvoice.CarrierLookupResult,
      smsvoice.CarrierLookupError
    >
  >
> {}
export const CarrierLookup = Binding.Service<CarrierLookup>(
  "AWS.PinpointSMSVoiceV2.CarrierLookup",
);
