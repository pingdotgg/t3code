import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:DescribeRecord`.
 *
 * Gets a provisioning record — the result of a provision, update, or terminate request. Poll it until the record status is `SUCCEEDED` or `FAILED`.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.DescribeRecordHttp)`.
 * @binding
 * @section Tracking Provisioned Products
 * @example Poll a Provisioning Record to Completion
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeRecord = yield* AWS.ServiceCatalog.DescribeRecord();
 *
 * // runtime
 * const { RecordDetail } = yield* describeRecord({
 *   Id: "rec-abc123",
 * });
 * ```
 */
export interface DescribeRecord extends Binding.Service<
  DescribeRecord,
  "AWS.ServiceCatalog.DescribeRecord",
  () => Effect.Effect<
    (
      request: servicecatalog.DescribeRecordInput,
    ) => Effect.Effect<
      servicecatalog.DescribeRecordOutput,
      servicecatalog.DescribeRecordError
    >
  >
> {}
export const DescribeRecord = Binding.Service<DescribeRecord>(
  "AWS.ServiceCatalog.DescribeRecord",
);
