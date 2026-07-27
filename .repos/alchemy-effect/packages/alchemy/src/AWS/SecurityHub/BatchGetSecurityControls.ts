import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:BatchGetSecurityControls`.
 *
 * Returns detailed definitions for a batch of security controls by id or ARN.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.BatchGetSecurityControlsHttp)`.
 * @binding
 * @section Standards & Controls
 * @example Hydrate Control Details
 * ```typescript
 * // init — account-level binding, no resource argument
 * const batchGetSecurityControls = yield* AWS.SecurityHub.BatchGetSecurityControls();
 *
 * // runtime
 * const { SecurityControls } = yield* batchGetSecurityControls({
 *   SecurityControlIds: ["IAM.1", "S3.1"],
 * });
 * ```
 */
export interface BatchGetSecurityControls extends Binding.Service<
  BatchGetSecurityControls,
  "AWS.SecurityHub.BatchGetSecurityControls",
  () => Effect.Effect<
    (
      request?: securityhub.BatchGetSecurityControlsRequest,
    ) => Effect.Effect<
      securityhub.BatchGetSecurityControlsResponse,
      securityhub.BatchGetSecurityControlsError
    >
  >
> {}
export const BatchGetSecurityControls =
  Binding.Service<BatchGetSecurityControls>(
    "AWS.SecurityHub.BatchGetSecurityControls",
  );
