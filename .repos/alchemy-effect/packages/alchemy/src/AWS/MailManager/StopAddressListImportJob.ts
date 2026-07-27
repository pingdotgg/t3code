import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AddressList } from "./AddressList.ts";

/**
 * Runtime binding for `ses:StopAddressListImportJob`.
 *
 * Stops an in-flight import job. Addresses already imported remain on
 * the list. IAM access is granted on the bound list's ARN. Provide the implementation with
 * `Effect.provide(AWS.MailManager.StopAddressListImportJobHttp)`.
 * @binding
 * @section Bulk Importing Members
 * @example Stop an Import Job
 * ```typescript
 * const stopImportJob = yield* MailManager.StopAddressListImportJob(blockList);
 *
 * // runtime
 * yield* stopImportJob({ JobId });
 * ```
 */
export interface StopAddressListImportJob extends Binding.Service<
  StopAddressListImportJob,
  "AWS.MailManager.StopAddressListImportJob",
  (
    list: AddressList,
  ) => Effect.Effect<
    (
      request: mm.StopAddressListImportJobRequest,
    ) => Effect.Effect<
      mm.StopAddressListImportJobResponse,
      mm.StopAddressListImportJobError
    >
  >
> {}
export const StopAddressListImportJob =
  Binding.Service<StopAddressListImportJob>(
    "AWS.MailManager.StopAddressListImportJob",
  );
