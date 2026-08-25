import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:GetCodeSecurityScan`.
 *
 * Retrieves information about a specific code security scan.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.GetCodeSecurityScanHttp)`.
 * @binding
 * @section Code Security Scans
 * @example Poll a Code Security Scan
 * ```typescript
 * // init
 * const getCodeSecurityScan = yield* AWS.Inspector2.GetCodeSecurityScan();
 *
 * // runtime
 * const { status } = yield* getCodeSecurityScan({
 *   resource: { projectId },
 *   scanId,
 * });
 * ```
 */
export interface GetCodeSecurityScan extends Binding.Service<
  GetCodeSecurityScan,
  "AWS.Inspector2.GetCodeSecurityScan",
  () => Effect.Effect<
    (
      request: inspector2.GetCodeSecurityScanRequest,
    ) => Effect.Effect<
      inspector2.GetCodeSecurityScanResponse,
      inspector2.GetCodeSecurityScanError
    >
  >
> {}
export const GetCodeSecurityScan = Binding.Service<GetCodeSecurityScan>(
  "AWS.Inspector2.GetCodeSecurityScan",
);
