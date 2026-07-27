import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Contact } from "./Contact.ts";

/**
 * Runtime binding for `ssm-contacts:ListPagesByContact`.
 *
 * List the pages (individual engagement deliveries) sent to the bound
 * contact. The contact's ARN is injected as `ContactId`.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.ListPagesByContactHttp)`.
 * @binding
 * @section Working with Pages
 * @example List Pages Sent to a Contact
 * ```typescript
 * const listPagesByContact = yield* AWS.SSMContacts.ListPagesByContact(oncall);
 *
 * const { Pages } = yield* listPagesByContact();
 * ```
 */
export interface ListPagesByContact extends Binding.Service<
  ListPagesByContact,
  "AWS.SSMContacts.ListPagesByContact",
  (
    contact: Contact,
  ) => Effect.Effect<
    (
      request?: Omit<ssm.ListPagesByContactRequest, "ContactId">,
    ) => Effect.Effect<
      ssm.ListPagesByContactResult,
      ssm.ListPagesByContactError
    >
  >
> {}
export const ListPagesByContact = Binding.Service<ListPagesByContact>(
  "AWS.SSMContacts.ListPagesByContact",
);
