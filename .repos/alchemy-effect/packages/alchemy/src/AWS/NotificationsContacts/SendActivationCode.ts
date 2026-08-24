import type * as contacts from "@distilled.cloud/aws/notificationscontacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EmailContact } from "./EmailContact.ts";

/**
 * Runtime binding for `notifications-contacts:SendActivationCode`.
 *
 * Send (or re-send) the activation email to the bound contact's address.
 * The email contains the activation code the address owner uses to confirm
 * the contact (directly via the emailed link, or through your app via
 * {@link ActivateEmailContact}). Provide the implementation with
 * `Effect.provide(AWS.NotificationsContacts.SendActivationCodeHttp)`.
 * @binding
 * @section Activating a Contact
 * @example Re-send the Activation Email
 * ```typescript
 * // init — bind the operation to the contact
 * const sendActivationCode =
 *   yield* AWS.NotificationsContacts.SendActivationCode(contact);
 *
 * // runtime — e.g. behind a "resend confirmation email" button
 * yield* sendActivationCode();
 * ```
 */
export interface SendActivationCode extends Binding.Service<
  SendActivationCode,
  "AWS.NotificationsContacts.SendActivationCode",
  (
    contact: EmailContact,
  ) => Effect.Effect<
    () => Effect.Effect<
      contacts.SendActivationCodeResponse,
      contacts.SendActivationCodeError
    >
  >
> {}

export const SendActivationCode = Binding.Service<SendActivationCode>(
  "AWS.NotificationsContacts.SendActivationCode",
);
