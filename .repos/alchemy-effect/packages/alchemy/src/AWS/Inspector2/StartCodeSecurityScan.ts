import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:StartCodeSecurityScan`.
 *
 * Initiates a code security scan on a specified repository.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.StartCodeSecurityScanHttp)`.
 * @binding
 * @section Code Security Scans
 * @example Scan a Repository
 * ```typescript
 * // init
 * const startCodeSecurityScan = yield* AWS.Inspector2.StartCodeSecurityScan();
 *
 * // runtime
 * const { scanId, status } = yield* startCodeSecurityScan({
 *   resource: { projectId },
 * });
 * ```
 */
export interface StartCodeSecurityScan extends Binding.Service<
  StartCodeSecurityScan,
  "AWS.Inspector2.StartCodeSecurityScan",
  () => Effect.Effect<
    (
      request: inspector2.StartCodeSecurityScanRequest,
    ) => Effect.Effect<
      inspector2.StartCodeSecurityScanResponse,
      inspector2.StartCodeSecurityScanError
    >
  >
> {}
export const StartCodeSecurityScan = Binding.Service<StartCodeSecurityScan>(
  "AWS.Inspector2.StartCodeSecurityScan",
);
