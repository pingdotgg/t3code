import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:BatchImportFindings`.
 *
 * Imports findings in AWS Security Finding Format (ASFF) from a custom integration into Security Hub.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.BatchImportFindingsHttp)`.
 * ### Working with Findings
 * **Example:** Import a Custom Finding
 * ```typescript
 * // init — account-level binding, no resource argument
 * const batchImportFindings = yield* AWS.SecurityHub.BatchImportFindings();
 *
 * // runtime
 * const { SuccessCount } = yield* batchImportFindings({
 *   Findings: [myAsffFinding],
 * });
 * ```
 *
 * @binding
 */
export interface BatchImportFindings extends Binding.Service<
  BatchImportFindings,
  "AWS.SecurityHub.BatchImportFindings",
  () => Effect.Effect<
    (
      request?: securityhub.BatchImportFindingsRequest,
    ) => Effect.Effect<
      securityhub.BatchImportFindingsResponse,
      securityhub.BatchImportFindingsError
    >
  >
> {}
export const BatchImportFindings = Binding.Service<BatchImportFindings>(
  "AWS.SecurityHub.BatchImportFindings",
);
