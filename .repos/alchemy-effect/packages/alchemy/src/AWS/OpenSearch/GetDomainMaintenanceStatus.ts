import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetDomainMaintenanceStatus` operation (IAM action
 * `es:GetDomainMaintenanceStatus`).
 *
 * Reads the status of one in-progress or completed maintenance action started with `StartDomainMaintenance`. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.GetDomainMaintenanceStatusHttp)`.
 * @binding
 * @section Domain Maintenance
 * @example Check a Maintenance Action
 * ```typescript
 * const getDomainMaintenanceStatus = yield* OpenSearch.GetDomainMaintenanceStatus();
 *
 * const result = yield* getDomainMaintenanceStatus({
 *   DomainName: name,
 *   MaintenanceId: maintenanceId,
 * });
 * // result.Status → "COMPLETED"
 * ```
 */
export interface GetDomainMaintenanceStatus extends Binding.Service<
  GetDomainMaintenanceStatus,
  "AWS.OpenSearch.GetDomainMaintenanceStatus",
  () => Effect.Effect<
    (
      request: opensearch.GetDomainMaintenanceStatusRequest,
    ) => Effect.Effect<
      opensearch.GetDomainMaintenanceStatusResponse,
      opensearch.GetDomainMaintenanceStatusError
    >
  >
> {}
export const GetDomainMaintenanceStatus =
  Binding.Service<GetDomainMaintenanceStatus>(
    "AWS.OpenSearch.GetDomainMaintenanceStatus",
  );
