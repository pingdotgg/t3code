import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CancelServiceSoftwareUpdate` operation (IAM action
 * `es:CancelServiceSoftwareUpdate`).
 *
 * Cancels a scheduled service software update — only while the update is in the `PENDING_UPDATE` state. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.CancelServiceSoftwareUpdateHttp)`.
 * @binding
 * @section Service Software Updates
 * @example Cancel a Pending Update
 * ```typescript
 * const cancelServiceSoftwareUpdate = yield* OpenSearch.CancelServiceSoftwareUpdate();
 *
 * const result = yield* cancelServiceSoftwareUpdate({ DomainName: name });
 * // result.ServiceSoftwareOptions?.UpdateStatus → "NOT_ELIGIBLE" | "ELIGIBLE"
 * ```
 */
export interface CancelServiceSoftwareUpdate extends Binding.Service<
  CancelServiceSoftwareUpdate,
  "AWS.OpenSearch.CancelServiceSoftwareUpdate",
  () => Effect.Effect<
    (
      request: opensearch.CancelServiceSoftwareUpdateRequest,
    ) => Effect.Effect<
      opensearch.CancelServiceSoftwareUpdateResponse,
      opensearch.CancelServiceSoftwareUpdateError
    >
  >
> {}
export const CancelServiceSoftwareUpdate =
  Binding.Service<CancelServiceSoftwareUpdate>(
    "AWS.OpenSearch.CancelServiceSoftwareUpdate",
  );
