import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:BatchUpdateFindings`.
 *
 * Updates workflow status, severity, notes, and other customer-editable fields on one or more findings.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.BatchUpdateFindingsHttp)`.
 * @binding
 * @section Working with Findings
 * @example Resolve a Finding
 * ```typescript
 * // init — account-level binding, no resource argument
 * const batchUpdateFindings = yield* AWS.SecurityHub.BatchUpdateFindings();
 *
 * // runtime
 * yield* batchUpdateFindings({
 *   FindingIdentifiers: [{ Id: findingId, ProductArn: productArn }],
 *   Workflow: { Status: "RESOLVED" },
 * });
 * ```
 */
export interface BatchUpdateFindings extends Binding.Service<
  BatchUpdateFindings,
  "AWS.SecurityHub.BatchUpdateFindings",
  () => Effect.Effect<
    (
      request?: securityhub.BatchUpdateFindingsRequest,
    ) => Effect.Effect<
      securityhub.BatchUpdateFindingsResponse,
      securityhub.BatchUpdateFindingsError
    >
  >
> {}
export const BatchUpdateFindings = Binding.Service<BatchUpdateFindings>(
  "AWS.SecurityHub.BatchUpdateFindings",
);
