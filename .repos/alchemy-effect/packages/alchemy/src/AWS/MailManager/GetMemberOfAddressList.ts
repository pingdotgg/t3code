import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AddressList } from "./AddressList.ts";

/**
 * Runtime binding for `ses:GetMemberOfAddressList`.
 *
 * Fetches a single member of the bound address list (address +
 * registration timestamp), failing with `ResourceNotFoundException` when
 * the address is not on the list. The address list id is injected from
 * the binding. Provide the implementation with
 * `Effect.provide(AWS.MailManager.GetMemberOfAddressListHttp)`.
 * @binding
 * @section Managing Address List Members
 * @example Check Whether a Sender Is Blocked
 * ```typescript
 * const getMember = yield* MailManager.GetMemberOfAddressList(blockList);
 *
 * // runtime
 * const blocked = yield* getMember({ Address: sender }).pipe(
 *   Effect.map(() => true),
 *   Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(false)),
 * );
 * ```
 */
export interface GetMemberOfAddressList extends Binding.Service<
  GetMemberOfAddressList,
  "AWS.MailManager.GetMemberOfAddressList",
  (
    list: AddressList,
  ) => Effect.Effect<
    (
      request: Omit<mm.GetMemberOfAddressListRequest, "AddressListId">,
    ) => Effect.Effect<
      mm.GetMemberOfAddressListResponse,
      mm.GetMemberOfAddressListError
    >
  >
> {}
export const GetMemberOfAddressList = Binding.Service<GetMemberOfAddressList>(
  "AWS.MailManager.GetMemberOfAddressList",
);
