import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `application-signals:ListAuditFindings`.
 *
 * Returns audit findings — automated analysis of service behavior and root
 * causes (performance issues, anomalies, potential problems) for the given
 * audit targets. Provide the implementation with
 * `Effect.provide(AWS.ApplicationSignals.ListAuditFindingsHttp)`.
 * @binding
 * @section Auditing Services
 * @example List Audit Findings for a Service
 * ```typescript
 * // init — account-level, no resource argument
 * const listAuditFindings = yield* AWS.ApplicationSignals.ListAuditFindings();
 *
 * // runtime
 * const result = yield* listAuditFindings({
 *   StartTime: new Date(Date.now() - 3600_000),
 *   EndTime: new Date(),
 *   AuditTargets: [
 *     {
 *       Type: "service",
 *       Data: {
 *         Service: {
 *           Type: "Service",
 *           Name: "checkout-service",
 *           Environment: "eks:prod",
 *         },
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export interface ListAuditFindings extends Binding.Service<
  ListAuditFindings,
  "AWS.ApplicationSignals.ListAuditFindings",
  () => Effect.Effect<
    (
      request: appsignals.ListAuditFindingsInput,
    ) => Effect.Effect<
      appsignals.ListAuditFindingsOutput,
      appsignals.ListAuditFindingsError
    >
  >
> {}

export const ListAuditFindings = Binding.Service<ListAuditFindings>(
  "AWS.ApplicationSignals.ListAuditFindings",
);
