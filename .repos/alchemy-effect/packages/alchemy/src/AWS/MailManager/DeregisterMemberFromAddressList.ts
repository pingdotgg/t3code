import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AddressList } from "./AddressList.ts";

/**
 * Runtime binding for `ses:DeregisterMemberFromAddressList`.
 *
 * Removes an email address from the bound address list. The address
 * list id is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MailManager.DeregisterMemberFromAddressListHttp)`.
 * ### Managing Address List Members
 * **Example:** Unblock a Sender
 * ```typescript
 * const deregisterMember = yield* MailManager.DeregisterMemberFromAddressList(blockList);
 *
 * // runtime
 * yield* deregisterMember({ Address: "reformed@example.com" });
 * ```
 *
 * @binding
 */
export interface DeregisterMemberFromAddressList extends Binding.Service<
  DeregisterMemberFromAddressList,
  "AWS.MailManager.DeregisterMemberFromAddressList",
  (
    list: AddressList,
  ) => Effect.Effect<
    (
      request: Omit<mm.DeregisterMemberFromAddressListRequest, "AddressListId">,
    ) => Effect.Effect<
      mm.DeregisterMemberFromAddressListResponse,
      mm.DeregisterMemberFromAddressListError
    >
  >
> {}
export const DeregisterMemberFromAddressList =
  Binding.Service<DeregisterMemberFromAddressList>(
    "AWS.MailManager.DeregisterMemberFromAddressList",
  );
