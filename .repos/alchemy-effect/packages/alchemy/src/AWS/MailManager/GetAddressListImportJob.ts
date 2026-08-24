import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AddressList } from "./AddressList.ts";

/**
 * Runtime binding for `ses:GetAddressListImportJob`.
 *
 * Fetches the detail and status of an import job created against the
 * bound address list (by `JobId`). IAM access is granted on the bound
 * list's ARN. Provide the implementation with
 * `Effect.provide(AWS.MailManager.GetAddressListImportJobHttp)`.
 * @binding
 * @section Bulk Importing Members
 * @example Poll an Import Job
 * ```typescript
 * const getImportJob = yield* MailManager.GetAddressListImportJob(blockList);
 *
 * // runtime
 * const job = yield* getImportJob({ JobId });
 * if (job.Status === "COMPLETED") {
 *   yield* Effect.log(`imported ${job.ImportedItemsCount} addresses`);
 * }
 * ```
 */
export interface GetAddressListImportJob extends Binding.Service<
  GetAddressListImportJob,
  "AWS.MailManager.GetAddressListImportJob",
  (
    list: AddressList,
  ) => Effect.Effect<
    (
      request: mm.GetAddressListImportJobRequest,
    ) => Effect.Effect<
      mm.GetAddressListImportJobResponse,
      mm.GetAddressListImportJobError
    >
  >
> {}
export const GetAddressListImportJob = Binding.Service<GetAddressListImportJob>(
  "AWS.MailManager.GetAddressListImportJob",
);
