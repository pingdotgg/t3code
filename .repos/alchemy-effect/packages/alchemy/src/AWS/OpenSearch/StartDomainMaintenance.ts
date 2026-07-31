import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `StartDomainMaintenance` operation (IAM action
 * `es:StartDomainMaintenance`).
 *
 * Starts a maintenance action on a domain — reboot a node, restart the search process, or restart Dashboards — e.g. remediation triggered by a health alarm. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.StartDomainMaintenanceHttp)`.
 * @binding
 * @section Domain Maintenance
 * @example Reboot a Data Node
 * ```typescript
 * const startDomainMaintenance = yield* OpenSearch.StartDomainMaintenance();
 *
 * const result = yield* startDomainMaintenance({
 *   DomainName: name,
 *   Action: "REBOOT_NODE",
 *   NodeId: nodeId,
 * });
 * // result.MaintenanceId → track with GetDomainMaintenanceStatus
 * ```
 */
export interface StartDomainMaintenance extends Binding.Service<
  StartDomainMaintenance,
  "AWS.OpenSearch.StartDomainMaintenance",
  () => Effect.Effect<
    (
      request: opensearch.StartDomainMaintenanceRequest,
    ) => Effect.Effect<
      opensearch.StartDomainMaintenanceResponse,
      opensearch.StartDomainMaintenanceError
    >
  >
> {}
export const StartDomainMaintenance = Binding.Service<StartDomainMaintenance>(
  "AWS.OpenSearch.StartDomainMaintenance",
);
