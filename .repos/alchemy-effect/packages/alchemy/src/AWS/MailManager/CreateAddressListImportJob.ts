import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AddressList } from "./AddressList.ts";

/**
 * Runtime binding for `ses:CreateAddressListImportJob`.
 *
 * Creates a bulk import job against the bound address list, returning
 * the job id and a pre-signed URL to upload the address data (CSV or
 * JSON). The address list id is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MailManager.CreateAddressListImportJobHttp)`.
 * @binding
 * @section Bulk Importing Members
 * @example Create an Import Job
 * ```typescript
 * const createImportJob = yield* MailManager.CreateAddressListImportJob(blockList);
 *
 * // runtime
 * const { JobId, PreSignedUrl } = yield* createImportJob({
 *   Name: "nightly-sync",
 *   ImportDataFormat: { ImportDataType: "CSV" },
 * });
 * // upload the CSV to PreSignedUrl, then start the job
 * ```
 */
export interface CreateAddressListImportJob extends Binding.Service<
  CreateAddressListImportJob,
  "AWS.MailManager.CreateAddressListImportJob",
  (
    list: AddressList,
  ) => Effect.Effect<
    (
      request: Omit<mm.CreateAddressListImportJobRequest, "AddressListId">,
    ) => Effect.Effect<
      mm.CreateAddressListImportJobResponse,
      mm.CreateAddressListImportJobError
    >
  >
> {}
export const CreateAddressListImportJob =
  Binding.Service<CreateAddressListImportJob>(
    "AWS.MailManager.CreateAddressListImportJob",
  );
