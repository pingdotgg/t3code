import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:BatchGetMemberEc2DeepInspectionStatus`.
 *
 * Retrieves Amazon Inspector deep inspection activation status of multiple member accounts within
 * your organization. You must be the delegated administrator of an organization in Amazon Inspector to
 * use this API.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.BatchGetMemberEc2DeepInspectionStatusHttp)`.
 * @binding
 * @section Organization & Members
 * @example Read Members' Deep Inspection Status
 * ```typescript
 * // init
 * const batchGetMemberEc2DeepInspectionStatus = yield* AWS.Inspector2.BatchGetMemberEc2DeepInspectionStatus();
 *
 * // runtime
 * const { accountIds } = yield* batchGetMemberEc2DeepInspectionStatus();
 * ```
 */
export interface BatchGetMemberEc2DeepInspectionStatus extends Binding.Service<
  BatchGetMemberEc2DeepInspectionStatus,
  "AWS.Inspector2.BatchGetMemberEc2DeepInspectionStatus",
  () => Effect.Effect<
    (
      request?: inspector2.BatchGetMemberEc2DeepInspectionStatusRequest,
    ) => Effect.Effect<
      inspector2.BatchGetMemberEc2DeepInspectionStatusResponse,
      inspector2.BatchGetMemberEc2DeepInspectionStatusError
    >
  >
> {}
export const BatchGetMemberEc2DeepInspectionStatus =
  Binding.Service<BatchGetMemberEc2DeepInspectionStatus>(
    "AWS.Inspector2.BatchGetMemberEc2DeepInspectionStatus",
  );
