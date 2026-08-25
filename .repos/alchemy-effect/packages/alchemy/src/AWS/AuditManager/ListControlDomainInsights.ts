import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `auditmanager:ListControlDomainInsights`.
 *
 * Lists the latest analytics data for control domains across all
 * active assessments. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.ListControlDomainInsightsHttp)`.
 * @binding
 * @section Insights
 * @example Control-Domain Insights Across Assessments
 * ```typescript
 * const listControlDomainInsights = yield* AWS.AuditManager.ListControlDomainInsights();
 * const result = yield* listControlDomainInsights({ maxResults: 20 });
 * ```
 */
export interface ListControlDomainInsights extends Binding.Service<
  ListControlDomainInsights,
  "AWS.AuditManager.ListControlDomainInsights",
  () => Effect.Effect<
    (
      request?: auditmanager.ListControlDomainInsightsRequest,
    ) => Effect.Effect<
      auditmanager.ListControlDomainInsightsResponse,
      auditmanager.ListControlDomainInsightsError
    >
  >
> {}

export const ListControlDomainInsights =
  Binding.Service<ListControlDomainInsights>(
    "AWS.AuditManager.ListControlDomainInsights",
  );
