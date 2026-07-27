import type * as mm from "@distilled.cloud/aws/mailmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AddressList } from "./AddressList.ts";

/**
 * Runtime binding for `ses:StartAddressListImportJob`.
 *
 * Starts a created import job once its address data has been uploaded
 * to the pre-signed URL. IAM access is granted on the bound list's ARN. Provide the implementation with
 * `Effect.provide(AWS.MailManager.StartAddressListImportJobHttp)`.
 * @binding
 * @section Bulk Importing Members
 * @example Start an Import Job
 * ```typescript
 * const startImportJob = yield* MailManager.StartAddressListImportJob(blockList);
 *
 * // runtime
 * yield* startImportJob({ JobId });
 * ```
 */
export interface StartAddressListImportJob extends Binding.Service<
  StartAddressListImportJob,
  "AWS.MailManager.StartAddressListImportJob",
  (
    list: AddressList,
  ) => Effect.Effect<
    (
      request: mm.StartAddressListImportJobRequest,
    ) => Effect.Effect<
      mm.StartAddressListImportJobResponse,
      mm.StartAddressListImportJobError
    >
  >
> {}
export const StartAddressListImportJob =
  Binding.Service<StartAddressListImportJob>(
    "AWS.MailManager.StartAddressListImportJob",
  );
