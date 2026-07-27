import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:BatchUpdateMemberEc2DeepInspectionStatus`.
 *
 * Activates or deactivates Amazon Inspector deep inspection for the provided member accounts in your
 * organization. You must be the delegated administrator of an organization in Amazon Inspector to use
 * this API.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.BatchUpdateMemberEc2DeepInspectionStatusHttp)`.
 * @binding
 * @section Organization & Members
 * @example Toggle Members' Deep Inspection
 * ```typescript
 * // init
 * const batchUpdateMemberEc2DeepInspectionStatus = yield* AWS.Inspector2.BatchUpdateMemberEc2DeepInspectionStatus();
 *
 * // runtime
 * const { accountIds } = yield* batchUpdateMemberEc2DeepInspectionStatus({
 *   accountIds: [{ accountId, activateDeepInspection: true }],
 * });
 * ```
 */
export interface BatchUpdateMemberEc2DeepInspectionStatus extends Binding.Service<
  BatchUpdateMemberEc2DeepInspectionStatus,
  "AWS.Inspector2.BatchUpdateMemberEc2DeepInspectionStatus",
  () => Effect.Effect<
    (
      request: inspector2.BatchUpdateMemberEc2DeepInspectionStatusRequest,
    ) => Effect.Effect<
      inspector2.BatchUpdateMemberEc2DeepInspectionStatusResponse,
      inspector2.BatchUpdateMemberEc2DeepInspectionStatusError
    >
  >
> {}
export const BatchUpdateMemberEc2DeepInspectionStatus =
  Binding.Service<BatchUpdateMemberEc2DeepInspectionStatus>(
    "AWS.Inspector2.BatchUpdateMemberEc2DeepInspectionStatus",
  );
