import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AddressList } from "./AddressList.ts";

/**
 * Runtime binding for `ses:RegisterMemberToAddressList`.
 *
 * Adds an email address to the bound address list. The address list id
 * is injected from the binding. Registering an already-present address
 * succeeds (idempotent upsert). Provide the implementation with
 * `Effect.provide(AWS.MailManager.RegisterMemberToAddressListHttp)`.
 * @binding
 * @section Managing Address List Members
 * @example Block a Sender
 * ```typescript
 * // init — bind the operation to the address list
 * const registerMember = yield* MailManager.RegisterMemberToAddressList(blockList);
 *
 * // runtime
 * yield* registerMember({ Address: "spammer@example.com" });
 * ```
 */
export interface RegisterMemberToAddressList extends Binding.Service<
  RegisterMemberToAddressList,
  "AWS.MailManager.RegisterMemberToAddressList",
  (
    list: AddressList,
  ) => Effect.Effect<
    (
      request: Omit<mm.RegisterMemberToAddressListRequest, "AddressListId">,
    ) => Effect.Effect<
      mm.RegisterMemberToAddressListResponse,
      mm.RegisterMemberToAddressListError
    >
  >
> {}
export const RegisterMemberToAddressList =
  Binding.Service<RegisterMemberToAddressList>(
    "AWS.MailManager.RegisterMemberToAddressList",
  );
