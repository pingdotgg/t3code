import type * as contacts from "@distilled.cloud/aws/notificationscontacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EmailContact } from "./EmailContact.ts";

/**
 * Runtime binding for `notifications-contacts:GetEmailContact`.
 *
 * Read the bound email contact — most usefully its activation `status`,
 * which flips from `inactive` to `active` once the address owner confirms
 * the activation email. Provide the implementation with
 * `Effect.provide(AWS.NotificationsContacts.GetEmailContactHttp)`.
 * @binding
 * @section Checking Activation Status
 * @example Read the Contact's Status
 * ```typescript
 * // init — bind the operation to the contact
 * const getContact = yield* AWS.NotificationsContacts.GetEmailContact(contact);
 *
 * // runtime
 * const result = yield* getContact();
 * const isActive = result.emailContact.status === "active";
 * ```
 */
export interface GetEmailContact extends Binding.Service<
  GetEmailContact,
  "AWS.NotificationsContacts.GetEmailContact",
  (
    contact: EmailContact,
  ) => Effect.Effect<
    () => Effect.Effect<
      contacts.GetEmailContactResponse,
      contacts.GetEmailContactError
    >
  >
> {}

export const GetEmailContact = Binding.Service<GetEmailContact>(
  "AWS.NotificationsContacts.GetEmailContact",
);
