import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AddressList } from "./AddressList.ts";

/**
 * Runtime binding for `ses:ListAddressListImportJobs`.
 *
 * Lists the import jobs created against the bound address list. The
 * address list id is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MailManager.ListAddressListImportJobsHttp)`.
 * @binding
 * @section Bulk Importing Members
 * @example List Import Jobs
 * ```typescript
 * const listImportJobs = yield* MailManager.ListAddressListImportJobs(blockList);
 *
 * // runtime
 * const { ImportJobs } = yield* listImportJobs({});
 * ```
 */
export interface ListAddressListImportJobs extends Binding.Service<
  ListAddressListImportJobs,
  "AWS.MailManager.ListAddressListImportJobs",
  (
    list: AddressList,
  ) => Effect.Effect<
    (
      request: Omit<mm.ListAddressListImportJobsRequest, "AddressListId">,
    ) => Effect.Effect<
      mm.ListAddressListImportJobsResponse,
      mm.ListAddressListImportJobsError
    >
  >
> {}
export const ListAddressListImportJobs =
  Binding.Service<ListAddressListImportJobs>(
    "AWS.MailManager.ListAddressListImportJobs",
  );
