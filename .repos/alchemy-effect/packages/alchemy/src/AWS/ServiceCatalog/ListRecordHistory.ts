import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:ListRecordHistory`.
 *
 * Lists the caller's past provisioning records (provision, update, and terminate requests), newest first.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.ListRecordHistoryHttp)`.
 * @binding
 * @section Tracking Provisioned Products
 * @example List Past Provisioning Records
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listRecordHistory = yield* AWS.ServiceCatalog.ListRecordHistory();
 *
 * // runtime
 * const { RecordDetails } = yield* listRecordHistory();
 * ```
 */
export interface ListRecordHistory extends Binding.Service<
  ListRecordHistory,
  "AWS.ServiceCatalog.ListRecordHistory",
  () => Effect.Effect<
    (
      request?: servicecatalog.ListRecordHistoryInput,
    ) => Effect.Effect<
      servicecatalog.ListRecordHistoryOutput,
      servicecatalog.ListRecordHistoryError
    >
  >
> {}
export const ListRecordHistory = Binding.Service<ListRecordHistory>(
  "AWS.ServiceCatalog.ListRecordHistory",
);
