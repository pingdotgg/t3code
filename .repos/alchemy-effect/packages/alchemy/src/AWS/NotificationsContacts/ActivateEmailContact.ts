import type * as contacts from "@distilled.cloud/aws/notificationscontacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EmailContact } from "./EmailContact.ts";

/**
 * Request for {@link ActivateEmailContact} — the bound contact's ARN is
 * injected automatically. The activation `code` is the one AWS emailed to
 * the contact's address (a one-time token — pass it as
 * `Redacted.make(code)` to keep it out of logs).
 */
export interface ActivateEmailContactRequest extends Omit<
  contacts.ActivateEmailContactRequest,
  "arn"
> {}

/**
 * Runtime binding for `notifications-contacts:ActivateEmailContact`.
 *
 * Activate the bound email contact with the activation code the address
 * owner received (see {@link SendActivationCode}) — e.g. from a
 * confirmation form in your app. Provide the implementation with
 * `Effect.provide(AWS.NotificationsContacts.ActivateEmailContactHttp)`.
 * @binding
 * @section Activating a Contact
 * @example Activate with a User-Supplied Code
 * ```typescript
 * // init — bind the operation to the contact
 * const activate = yield* AWS.NotificationsContacts.ActivateEmailContact(contact);
 *
 * // runtime — the user pasted the code from the activation email
 * yield* activate({ code: Redacted.make(userSuppliedCode) });
 * ```
 */
export interface ActivateEmailContact extends Binding.Service<
  ActivateEmailContact,
  "AWS.NotificationsContacts.ActivateEmailContact",
  (
    contact: EmailContact,
  ) => Effect.Effect<
    (
      request: ActivateEmailContactRequest,
    ) => Effect.Effect<
      contacts.ActivateEmailContactResponse,
      contacts.ActivateEmailContactError
    >
  >
> {}

export const ActivateEmailContact = Binding.Service<ActivateEmailContact>(
  "AWS.NotificationsContacts.ActivateEmailContact",
);
