import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AddressList } from "./AddressList.ts";

/**
 * Runtime binding for `ses:ListMembersOfAddressList`.
 *
 * Lists the members of the bound address list, optionally filtered by
 * address prefix. The address list id is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MailManager.ListMembersOfAddressListHttp)`.
 * @binding
 * @section Managing Address List Members
 * @example Enumerate the Block List
 * ```typescript
 * const listMembers = yield* MailManager.ListMembersOfAddressList(blockList);
 *
 * // runtime
 * const { Addresses } = yield* listMembers({});
 * ```
 */
export interface ListMembersOfAddressList extends Binding.Service<
  ListMembersOfAddressList,
  "AWS.MailManager.ListMembersOfAddressList",
  (
    list: AddressList,
  ) => Effect.Effect<
    (
      request: Omit<mm.ListMembersOfAddressListRequest, "AddressListId">,
    ) => Effect.Effect<
      mm.ListMembersOfAddressListResponse,
      mm.ListMembersOfAddressListError
    >
  >
> {}
export const ListMembersOfAddressList =
  Binding.Service<ListMembersOfAddressList>(
    "AWS.MailManager.ListMembersOfAddressList",
  );
