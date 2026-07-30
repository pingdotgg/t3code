import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Runtime binding for `social-messaging:GetLinkedWhatsAppBusinessAccountPhoneNumber`.
 *
 * Retrieves the details (display name, quality rating, Meta ids) of one of
 * the linked account's WhatsApp phone numbers, plus the owning WABA id.
 *
 * The caller addresses one of the bound account's phone numbers per
 * request; phone-number ARNs are provisioned by Meta under the WABA, so
 * the deploy-time half grants `social-messaging:GetLinkedWhatsAppBusinessAccountPhoneNumber` on `*`.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.GetLinkedWhatsAppBusinessAccountPhoneNumberHttp)`.
 * @binding
 * @section Reading Phone Numbers
 * @example Read Phone Number Details
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const getPhoneNumber = yield* AWS.SocialMessaging.GetLinkedWhatsAppBusinessAccountPhoneNumber(account);
 *
 * // runtime
 * const details = yield* getPhoneNumber({
 *   id: "phone-number-id-0123456789abcdef",
 * });
 * const rating = details.phoneNumber?.qualityRating;
 * ```
 */
export interface GetLinkedWhatsAppBusinessAccountPhoneNumber extends Binding.Service<
  GetLinkedWhatsAppBusinessAccountPhoneNumber,
  "AWS.SocialMessaging.GetLinkedWhatsAppBusinessAccountPhoneNumber",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: socialmessaging.GetLinkedWhatsAppBusinessAccountPhoneNumberInput,
    ) => Effect.Effect<
      socialmessaging.GetLinkedWhatsAppBusinessAccountPhoneNumberOutput,
      socialmessaging.GetLinkedWhatsAppBusinessAccountPhoneNumberError
    >
  >
> {}
export const GetLinkedWhatsAppBusinessAccountPhoneNumber =
  Binding.Service<GetLinkedWhatsAppBusinessAccountPhoneNumber>(
    "AWS.SocialMessaging.GetLinkedWhatsAppBusinessAccountPhoneNumber",
  );
